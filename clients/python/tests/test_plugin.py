"""The pytest plugin, driven the way a user drives it: a real pytest run over real test files.

``pytester`` runs the inner sessions. The plugin reaches them through its ``pytest11`` entry point,
and the mocks behind them are real: this repository's server for ``ORCID_MOCK_URL`` mode, and a
container for the rest.
"""

from __future__ import annotations

import json

import pytest

from orcid_mock._shared import resolve_image


@pytest.fixture
def url_mode(monkeypatch: pytest.MonkeyPatch, repo_server: str) -> str:
    monkeypatch.setenv("ORCID_MOCK_URL", repo_server)
    return repo_server


@pytest.fixture
def container_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ORCID_MOCK_URL", raising=False)


def test_the_options_are_listed_in_help(pytester: pytest.Pytester) -> None:
    result = pytester.runpytest_inprocess("--help")
    result.stdout.fnmatch_lines(["*--orcid-mock-image=IMAGE*", "*--orcid-mock-users=FILE*"])


def test_url_mode_yields_a_client_for_the_running_instance(
    pytester: pytest.Pytester, url_mode: str
) -> None:
    pytester.makepyfile(
        f"""
        def test_connects(orcid_mock):
            assert orcid_mock.base_url == {url_mode!r}
            assert orcid_mock.health()["status"] == "ok"

        def test_signs_in(orcid_mock):
            alder = orcid_mock.users()[0]
            assert orcid_mock.sign_in(alder["orcid"])["orcid"] == alder["orcid"]
        """
    )
    pytester.runpytest_inprocess().assert_outcomes(passed=2)


def test_the_reset_fixture_resets_before_each_test_that_asks_for_it(
    pytester: pytest.Pytester, url_mode: str
) -> None:
    pytester.makepyfile(
        """
        USER = {"name": {"given_names": "Fresh", "family_name": "Tester", "visibility": "public"}}

        def test_first_creates_a_user(orcid_mock_reset):
            orcid_mock_reset.create_user(USER)
            assert len(orcid_mock_reset.users()) == 4

        def test_second_sees_the_baseline_again(orcid_mock_reset):
            assert len(orcid_mock_reset.users()) == 3
            orcid_mock_reset.put_client(
                "APP-GONE", {"client_secret": "s", "redirect_uris": ["http://localhost:1/cb"]}
            )

        def test_third_sees_the_client_gone(orcid_mock_reset):
            assert orcid_mock_reset.health()["clients"] == 2
        """
    )
    pytester.runpytest_inprocess().assert_outcomes(passed=3)


def test_orcid_mock_is_session_scoped_and_the_reset_fixture_is_not(
    pytester: pytest.Pytester, url_mode: str
) -> None:
    pytester.makepyfile("def test_one(orcid_mock_reset):\n    pass\n")
    result = pytester.runpytest_inprocess("--setup-show")
    result.stdout.fnmatch_lines(["*SETUP    S orcid_mock*", "*SETUP    F orcid_mock_reset*"])


def test_users_cannot_be_set_on_a_running_instance(
    pytester: pytest.Pytester, url_mode: str
) -> None:
    users = pytester.makefile(".json", users=json.dumps({"clients": [], "users": []}))
    pytester.makepyfile("def test_x(orcid_mock):\n    pass\n")
    result = pytester.runpytest_inprocess("--orcid-mock-users", str(users))
    result.assert_outcomes(errors=1)
    result.stdout.fnmatch_lines([f"*ORCID_MOCK_URL is set ({url_mode})*--orcid-mock-users*"])


def test_a_url_where_nothing_answers_is_an_error_naming_it(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ORCID_MOCK_URL", "http://127.0.0.1:1")
    pytester.makepyfile("def test_x(orcid_mock):\n    pass\n")
    result = pytester.runpytest_inprocess()
    result.assert_outcomes(errors=1)
    result.stdout.fnmatch_lines(["*http://127.0.0.1:1*does not answer*"])


def test_container_mode_starts_a_container_from_the_image_and_users_options(
    pytester: pytest.Pytester, container_mode: None
) -> None:
    users = pytester.makefile(
        ".json",
        users=json.dumps(
            {
                "clients": [],
                "users": [
                    {
                        "orcid": "0000-0002-1825-0097",
                        "name": {"given_names": "Josiah", "visibility": "public"},
                    }
                ],
            }
        ),
    )
    pytester.makepyfile(
        """
        def test_serves_the_given_users(orcid_mock):
            assert [u["orcid"] for u in orcid_mock.users()] == ["0000-0002-1825-0097"]
            assert orcid_mock.base_url.startswith("http://localhost:")
        """
    )
    result = pytester.runpytest_inprocess(
        "--orcid-mock-image", resolve_image(), "--orcid-mock-users", str(users)
    )
    result.assert_outcomes(passed=1)


def test_container_mode_without_options_serves_the_starter_users(
    pytester: pytest.Pytester, container_mode: None
) -> None:
    pytester.makepyfile(
        """
        def test_starter(orcid_mock):
            assert orcid_mock.health() == {"status": "ok", "users": 3, "clients": 2}
        """
    )
    pytester.runpytest_inprocess().assert_outcomes(passed=1)
