"""The Testcontainers module against real containers."""

from __future__ import annotations

import json
import re
import stat
from pathlib import Path

import httpx
import pytest

from orcid_mock import OrcidMockContainer, OrcidMockStartError


def user(given: str, email: str, orcid: str | None = None) -> dict:
    body: dict = {
        "name": {"given_names": given, "family_name": "Tester", "visibility": "public"},
        "emails": [{"email": email, "primary": True, "verified": True, "visibility": "public"}],
    }
    if orcid is not None:
        body["orcid"] = orcid
    return body


def test_starts_on_a_published_port_with_its_base_url_and_a_ready_client(
    container: OrcidMockContainer,
) -> None:
    assert container.base_url.startswith("http://localhost:")
    assert container.client.base_url == container.base_url
    assert container.client.health() == {"status": "ok", "users": 3, "clients": 2}
    port = int(container.base_url.rsplit(":", 1)[1])
    assert container.get_exposed_port(9700) == port


def test_the_mock_believes_it_is_at_the_published_address(container: OrcidMockContainer) -> None:
    # The consent page's form posts back to a URL built from PUBLIC_BASE_URL.
    page = httpx.get(
        f"{container.base_url}/oauth/authorize",
        params={
            "client_id": "APP-ORCIDMOCK000001",
            "response_type": "code",
            "scope": "/authenticate",
            "redirect_uri": "http://localhost:3000/callback",
        },
    )
    assert page.status_code == 200
    assert f'action="{container.base_url}/oauth/authorize"' in page.text


def test_the_base_url_is_unavailable_before_start() -> None:
    container = OrcidMockContainer()
    with pytest.raises(OrcidMockStartError, match="has not started"):
        _ = container.base_url


def test_serves_a_users_object_given_to_the_constructor() -> None:
    users = {"clients": [], "users": [user("Only", "only@example.test", "0000-0002-1825-0097")]}
    with OrcidMockContainer(users=users) as custom:
        assert custom.client.health() == {"status": "ok", "users": 1, "clients": 0}
        assert custom.client.user("0000-0002-1825-0097")["name"]["given_names"] == "Only"


def test_serves_a_users_file_given_by_path_whatever_its_permissions(tmp_path: Path) -> None:
    path = tmp_path / "users.json"
    path.write_text(
        json.dumps(
            {"clients": [], "users": [user("Filed", "filed@example.test", "0000-0001-5109-3700")]}
        )
    )
    path.chmod(0o600)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600

    with OrcidMockContainer().with_users(path) as custom:
        assert [u["orcid"] for u in custom.client.users()] == ["0000-0001-5109-3700"]


def test_a_users_file_the_server_rejects_fails_start_with_the_servers_own_message() -> None:
    bad = {"clients": [], "users": [user("Bad", "bad@example.test", "0000-0002-1825-0098")]}
    with pytest.raises(OrcidMockStartError) as failed:
        OrcidMockContainer(users=bad).start()
    assert "did not start" in str(failed.value)
    assert "check character" in str(failed.value)


def test_a_users_file_that_does_not_exist_fails_naming_the_path() -> None:
    with pytest.raises(OrcidMockStartError, match=re.escape("/no/such/users.json")):
        OrcidMockContainer(users="/no/such/users.json")


def test_a_missing_image_fails_start_naming_it() -> None:
    with pytest.raises(OrcidMockStartError, match="orcid-mock-does-not-exist:0"):
        OrcidMockContainer("orcid-mock-does-not-exist:0").start()


class _FirstPortTaken(OrcidMockContainer):
    """Offers a taken port first, then the operating system's."""

    def __init__(self, taken: int) -> None:
        super().__init__()
        self._taken = taken
        self._asked = 0

    def _pick_port(self) -> int:
        self._asked += 1
        return self._taken if self._asked == 1 else super()._pick_port()


class _AlwaysTaken(OrcidMockContainer):
    """Offers the same taken port every time."""

    def __init__(self, taken: int) -> None:
        super().__init__()
        self._taken = taken

    def _pick_port(self) -> int:
        return self._taken


def _port_of(container: OrcidMockContainer) -> int:
    return int(container.base_url.rsplit(":", 1)[1])


def test_a_port_that_docker_finds_taken_is_replaced_by_a_fresh_one(
    container: OrcidMockContainer,
) -> None:
    # The shared container's own published port is a real conflict: Docker refuses to bind it twice.
    with _FirstPortTaken(_port_of(container)) as raced:
        assert raced.base_url != container.base_url
        assert raced.client.health()["status"] == "ok"


def test_a_port_that_stays_taken_fails_start_with_dockers_own_message(
    container: OrcidMockContainer,
) -> None:
    with pytest.raises(
        OrcidMockStartError, match=r"already allocated|already in use|not available"
    ):
        _AlwaysTaken(_port_of(container)).start()


def test_two_containers_at_once_get_different_ports_and_each_knows_its_own_address(
    container: OrcidMockContainer,
) -> None:
    with OrcidMockContainer() as other:
        assert other.base_url != container.base_url
        other.client.create_user(user("Second", "second@example.test"))
        assert len(other.client.users()) == 4
        container.client.reset()
        assert len(container.client.users()) == 3


def test_stop_removes_the_container_and_closes_the_client() -> None:
    started = OrcidMockContainer().start()
    client = started.client
    assert client.health()["status"] == "ok"
    started.stop()
    with pytest.raises(RuntimeError, match="closed"):
        client.health()
    # Nothing answers at the old address any more.
    with pytest.raises(httpx.ConnectError):
        httpx.get(f"{started.base_url}/__admin/health")
