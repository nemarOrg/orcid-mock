"""A pytest plugin for orcid-mock: the ``orcid_mock`` and ``orcid_mock_reset`` fixtures.

``orcid_mock`` is session-scoped and yields an ``OrcidMockClient``. It connects to the running
instance ``ORCID_MOCK_URL`` names (the GitHub Action sets it) and starts a container otherwise.
``orcid_mock_reset`` resets the mock before each test that asks for it.

Options: ``--orcid-mock-image`` (default ``ORCID_MOCK_IMAGE``, then the image that matches this
package's version) and ``--orcid-mock-users`` (a users file for the container).
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from ._shared import url_from_env
from .client import OrcidMockClient
from .container import OrcidMockContainer


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("orcid-mock", "orcid-mock")
    group.addoption(
        "--orcid-mock-image",
        action="store",
        default=None,
        metavar="IMAGE",
        help="Image for the orcid_mock container (default: $ORCID_MOCK_IMAGE, then the image "
        "that matches the orcid-mock-testing version). Ignored when ORCID_MOCK_URL is set.",
    )
    group.addoption(
        "--orcid-mock-users",
        action="store",
        default=None,
        metavar="FILE",
        help="Users file the orcid_mock container serves instead of the starter users. "
        "An error when ORCID_MOCK_URL is set, since a running instance's users cannot be set here.",
    )


@pytest.fixture(scope="session")
def orcid_mock(request: pytest.FixtureRequest) -> Iterator[OrcidMockClient]:
    """The mock for this session: the instance ``ORCID_MOCK_URL`` names, or a container."""
    image: str | None = request.config.getoption("--orcid-mock-image")
    users: str | None = request.config.getoption("--orcid-mock-users")

    url = url_from_env()
    if url is not None:
        if users is not None:
            pytest.fail(
                f"ORCID_MOCK_URL is set ({url}), so a running orcid-mock is used and its users "
                "cannot be set by --orcid-mock-users. Load them where it starts, or unset "
                "ORCID_MOCK_URL to start a container.",
                pytrace=False,
            )
        client = OrcidMockClient(url)
        try:
            client.health()
        except Exception as error:
            client.close()
            pytest.fail(
                f"ORCID_MOCK_URL is set ({url}) but orcid-mock does not answer there: {error}",
                pytrace=False,
            )
        try:
            yield client
        finally:
            client.close()  # a running instance is never stopped
        return

    with OrcidMockContainer(image, users=users) as container:
        yield container.client


@pytest.fixture
def orcid_mock_reset(orcid_mock: OrcidMockClient) -> OrcidMockClient:
    """The ``orcid_mock`` client, after ``reset()``: users, clients, and the clock are the file's.

    A client registered with ``put_client`` is dropped by the reset, so register it after this
    fixture has run.
    """
    orcid_mock.reset()
    return orcid_mock
