"""Real mocks for the tests: a container, and this repository's server as a child process.

No test stands in for orcid-mock. A test that needs one starts the real thing, as a container from
``ORCID_MOCK_IMAGE`` or as ``bun run src/main.ts serve --port 0`` from the repository.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from orcid_mock import OrcidMockClient, OrcidMockContainer

pytest_plugins = ["pytester"]

REPO_ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def repo_server() -> Iterator[str]:
    """The URL of this repository's server, started on a free port as a child process."""
    bun = shutil.which("bun")
    assert bun is not None, "bun is required to start the server from the repository"
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}
    server = subprocess.Popen(  # noqa: S603 (bun is the one found on PATH)
        [bun, "run", str(REPO_ROOT / "src" / "main.ts"), "serve", "--port", "0"],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    # A server that never prints its readiness line would block readline forever.
    watchdog = threading.Timer(30, server.kill)
    watchdog.start()
    try:
        assert server.stdout is not None
        line = server.stdout.readline()
        # The watchdog guards only the wait for the readiness line; left running, it would kill
        # the session-scoped server 30 seconds in, under whichever test happens to be running.
        watchdog.cancel()
        assert '"event":"listening"' in line, (
            f"no readiness line from the repository server: {line!r}"
        )
        yield json.loads(line)["url"]
    finally:
        watchdog.cancel()
        server.terminate()
        server.wait(timeout=10)


@pytest.fixture(scope="session")
def container() -> Iterator[OrcidMockContainer]:
    """A started container, shared by every test that only needs one."""
    with OrcidMockContainer() as started:
        yield started


@pytest.fixture(params=["process", "container"])
def mock(request: pytest.FixtureRequest) -> Iterator[OrcidMockClient]:
    """A reset mock, once as this repository's server and once as a container."""
    if request.param == "process":
        client = OrcidMockClient(request.getfixturevalue("repo_server"))
    else:
        client = request.getfixturevalue("container").client
    client.reset()
    yield client
    if request.param == "process":
        client.close()
