"""The client against real mocks: this repository's server and a container, the same tests."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import httpx
import pytest

from orcid_mock import OrcidMockClient, OrcidMockError


def new_user(given: str, email: str) -> dict:
    return {
        "name": {"given_names": given, "family_name": "Tester", "visibility": "public"},
        "emails": [{"email": email, "primary": True, "verified": True, "visibility": "public"}],
    }


def test_health_counts_the_starter(mock: OrcidMockClient) -> None:
    assert mock.health() == {"status": "ok", "users": 3, "clients": 2}


def test_reset_undoes_creates_deletes_and_client_changes(mock: OrcidMockClient) -> None:
    before = mock.users()
    mock.create_user(new_user("Extra", "extra@example.test"))
    mock.delete_user(before[0]["orcid"])
    mock.put_client(
        "APP-RESET", {"client_secret": "s", "redirect_uris": ["http://localhost:4000/cb"]}
    )
    assert mock.health() == {"status": "ok", "users": 3, "clients": 3}

    assert mock.reset() == {"status": "ok", "users": 3, "clients": 2}
    assert mock.users() == before


def test_create_user_mints_an_id_reads_it_back_and_refuses_a_duplicate(
    mock: OrcidMockClient,
) -> None:
    created = mock.create_user(new_user("Minted", "minted@example.test"))
    assert created["orcid"].startswith("0009-9")
    assert mock.user(created["orcid"]) == created

    with pytest.raises(OrcidMockError) as refused:
        mock.create_user({**new_user("Again", "again@example.test"), "orcid": created["orcid"]})
    assert refused.value.status == 409


def test_put_user_creates_then_replaces(mock: OrcidMockClient) -> None:
    orcid = "0000-0002-1694-233X"
    assert mock.put_user(orcid, new_user("First", "put@example.test"))["orcid"] == orcid
    replaced = mock.put_user(orcid, new_user("Second", "put@example.test"))
    assert replaced["name"]["given_names"] == "Second"
    assert [user["orcid"] for user in mock.users()].count(orcid) == 1


def test_delete_user_removes_it_and_an_unknown_id_is_404(mock: OrcidMockClient) -> None:
    created = mock.create_user(new_user("Gone", "gone@example.test"))
    mock.delete_user(created["orcid"])
    with pytest.raises(OrcidMockError) as lookup:
        mock.user(created["orcid"])
    assert lookup.value.status == 404
    with pytest.raises(OrcidMockError) as again:
        mock.delete_user(created["orcid"])
    assert again.value.status == 404


def test_an_invalid_user_is_a_400_carrying_the_servers_issues(mock: OrcidMockClient) -> None:
    with pytest.raises(OrcidMockError) as refused:
        mock.create_user({**new_user("Bad", "bad@example.test"), "orcid": "0000-0002-1825-0098"})
    assert refused.value.status == 400
    assert "invalid_fixture" in refused.value.body
    assert "orcid" in refused.value.body


def test_advance_clock_returns_the_total_offset_and_reset_zeroes_it(mock: OrcidMockClient) -> None:
    assert mock.advance_clock(5) == 5_000
    assert mock.advance_clock(2) == 7_000
    mock.reset()
    assert mock.advance_clock(1) == 1_000


def test_sign_in_runs_the_headless_sequence(mock: OrcidMockClient) -> None:
    alder = mock.users()[0]
    token = mock.sign_in(alder["orcid"])
    assert token["orcid"] == alder["orcid"]
    assert token["token_type"] == "bearer"
    assert token["scope"] == "/authenticate"
    assert token["name"] == "A. Fennimore"


def test_sign_in_with_a_registered_client_a_scope_and_a_nonce(mock: OrcidMockClient) -> None:
    alder = mock.users()[0]
    mock.put_client(
        "APP-OWN",
        {"client_secret": "own-secret", "redirect_uris": ["http://localhost:4100/callback"]},
    )
    token = mock.sign_in(
        alder["orcid"],
        client_id="APP-OWN",
        client_secret="own-secret",
        redirect_uri="http://localhost:4100/callback",
        scope="openid",
        nonce="n-0S6_WzA2Mj",
    )
    assert token["orcid"] == alder["orcid"]
    assert token["scope"] == "openid"


def test_sign_in_as_a_locked_user_or_with_a_wrong_secret_is_an_error(mock: OrcidMockClient) -> None:
    users = mock.users()
    locked = next(user for user in users if user.get("locked"))
    open_user = next(user for user in users if not user.get("locked"))

    with pytest.raises(OrcidMockError) as refused:
        mock.sign_in(locked["orcid"])
    assert refused.value.status == 400

    with pytest.raises(OrcidMockError) as wrong:
        mock.sign_in(open_user["orcid"], client_secret="wrong")
    assert "/oauth/token" in str(wrong.value)


def test_sign_in_with_an_unregistered_redirect_uri_names_the_answer(mock: OrcidMockClient) -> None:
    with pytest.raises(OrcidMockError) as refused:
        mock.sign_in(mock.users()[0]["orcid"], redirect_uri="http://localhost:9/elsewhere")
    assert refused.value.status == 400
    assert "/oauth/authorize" in str(refused.value)


def test_a_scope_the_client_may_not_have_is_reported_as_the_error_redirect_it_is(
    mock: OrcidMockClient,
) -> None:
    # The public starter client may not ask for /read-limited: the mock redirects with
    # #error=invalid_scope, which carries no code.
    with pytest.raises(OrcidMockError) as refused:
        mock.sign_in(mock.users()[0]["orcid"], scope="/read-limited")
    assert "invalid_scope" in str(refused.value)
    # A redirect is not an HTTP error, so the error carries no status.
    assert refused.value.status == 0


def test_the_client_closes_and_strips_a_trailing_slash(repo_server: str) -> None:
    with OrcidMockClient(f"{repo_server}/") as client:
        assert client.base_url == repo_server
        assert client.health()["status"] == "ok"


@pytest.fixture
def recording_proxy(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[str]]:
    """A server that answers 502 to everything and records what reached it, named as the proxy."""
    seen: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            seen.append(self.path)
            self.send_response(502)
            self.send_header("content-length", "0")
            self.end_headers()

        do_POST = do_GET

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    proxy = f"http://127.0.0.1:{server.server_address[1]}"
    for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.setenv(name, proxy)
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.delenv(name, raising=False)
    try:
        yield seen
    finally:
        server.shutdown()
        server.server_close()


def test_a_proxy_in_the_environment_does_not_capture_the_mock_traffic(
    repo_server: str, recording_proxy: list[str]
) -> None:
    # The control: a client that trusts the environment is sent to the proxy, so the proxy
    # would capture the helper's traffic if the helper let it.
    with httpx.Client(trust_env=True) as plain:
        assert plain.get(f"{repo_server}/__admin/health").status_code == 502
    assert recording_proxy != []
    recording_proxy.clear()

    with OrcidMockClient(repo_server) as client:
        assert client.health()["status"] == "ok"
        assert client.sign_in(client.users()[0]["orcid"])["token_type"] == "bearer"
    assert recording_proxy == []
