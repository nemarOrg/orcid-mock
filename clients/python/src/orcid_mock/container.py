"""A Testcontainers module for orcid-mock.

The mock never derives its own address from the request (its ``PUBLIC_BASE_URL`` fixes the issuer
and every URL it emits), so the host port is chosen before the container starts and the base URL
handed to it. The port is bound explicitly, on the loopback interface only: the admin API has no
authentication.
"""

from __future__ import annotations

import contextlib
import json
import re
import socket
import time
from collections.abc import Mapping
from os import PathLike
from pathlib import Path
from typing import Any, Self, cast

from testcontainers.core.container import DockerContainer
from testcontainers.core.wait_strategies import LogMessageWaitStrategy

from ._shared import CONTAINER_PORT, CONTAINER_USERS_PATH, resolve_image
from .client import OrcidMockClient

UsersInput = str | PathLike[str] | Mapping[str, Any]
"""A users file: a path on disk, or the parsed object ``{"clients": [], "users": []}``."""

# Attempts at picking a free port before giving up; a lost race is the only reason to retry.
_PORT_ATTEMPTS = 3
_READY = re.compile(r'^\{"event":"listening"', re.MULTILINE)
_LOG_TAIL_LINES = 100


class OrcidMockStartError(RuntimeError):
    """The container did not start, or started but did not answer; the message holds its output."""


def _free_port() -> int:
    """A port the operating system says is free right now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _is_port_conflict(error: BaseException) -> bool:
    text = str(error)
    return bool(
        re.search(
            r"port is already allocated|address already in use|ports are not available", text, re.I
        )
    )


class OrcidMockContainer(DockerContainer):
    """An orcid-mock container, started on a port chosen up front.

    >>> with OrcidMockContainer(users="fixtures/users.json") as mock:  # doctest: +SKIP
    ...     token = mock.client.sign_in("0000-0002-1825-0097")

    The image is the ``image`` argument, else ``ORCID_MOCK_IMAGE``, else the image that matches
    this package's version. The Docker daemon must be on the machine that runs the tests, since the
    base URL is ``http://localhost:<port>``.
    """

    def __init__(self, image: str | None = None, *, users: UsersInput | None = None) -> None:
        super().__init__(resolve_image(image))
        # Every interface inside the container; the host side of the port is bound to loopback.
        self.with_env("HOST", "0.0.0.0")  # noqa: S104
        self.waiting_for(LogMessageWaitStrategy(_READY).with_startup_timeout(60))
        self._users: str | None = None
        self._base_url: str | None = None
        self._client: OrcidMockClient | None = None
        if users is not None:
            self.with_users(users)

    def with_users(self, users: UsersInput) -> Self:
        """Serve this users file instead of the bundled starter users.

        The content is copied into the container with mode 0644, so it works whatever the file's
        own permissions are (a bind mount must be readable by the image's ``nonroot`` user) and
        with a remote Docker daemon. A path is read now, so a missing file fails here.
        """
        if isinstance(users, Mapping):
            self._users = json.dumps(users)
        else:
            path = Path(users)
            try:
                self._users = path.read_text(encoding="utf-8")
            except OSError as error:
                message = f"cannot read the users file {path}: {error}"
                raise OrcidMockStartError(message) from error
        return self

    @property
    def base_url(self) -> str:
        """The address the mock is reachable at from the host, and its ``PUBLIC_BASE_URL``."""
        if self._base_url is None:
            message = "the container has not started"
            raise OrcidMockStartError(message)
        return self._base_url

    @property
    def client(self) -> OrcidMockClient:
        """A client for the admin API and the headless sign-in."""
        if self._client is None:
            self._client = OrcidMockClient(self.base_url)
        return self._client

    def start(self) -> Self:
        if self._users is not None:
            self.with_copy_into_container(self._users.encode(), CONTAINER_USERS_PATH, 0o644)
            self.with_env("USERS_FILE", CONTAINER_USERS_PATH)

        for attempt in range(1, _PORT_ATTEMPTS + 1):
            port = self._pick_port()
            base_url = f"http://localhost:{port}"
            self._bind(port, base_url)
            try:
                super().start()
                self._base_url = base_url
                self._wait_until_reachable()
            except Exception as error:
                logs = self._discard()
                if attempt < _PORT_ATTEMPTS and _is_port_conflict(error):
                    continue
                message = f"orcid-mock did not start from {self.image}: {error}"
                if logs:
                    message += f"\n--- container output ---\n{logs}"
                raise OrcidMockStartError(message) from error
            return self
        raise AssertionError("unreachable")  # pragma: no cover

    def stop(self, force: bool = True, delete_volume: bool = True) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None
        super().stop(force=force, delete_volume=delete_volume)

    def _pick_port(self) -> int:
        """A host port to publish on.

        The operating system's answer can be taken by the time Docker binds it, which ``start()``
        survives by asking again; a subclass can answer otherwise to prove that.
        """
        return _free_port()

    def _bind(self, port: int, base_url: str) -> None:
        """Publish the container port on ``port``, loopback only, and tell the mock its address."""
        # docker-py takes an (address, port) pair; testcontainers types the value as a port only.
        ports = cast("dict[str, Any]", self.ports)
        ports.clear()
        ports[f"{CONTAINER_PORT}/tcp"] = ("127.0.0.1", port)
        self.with_env("PUBLIC_BASE_URL", base_url)
        self._base_url = None

    def _wait_until_reachable(self) -> None:
        """The readiness line says the server listens; this says the published port reaches it."""
        last_error: Exception | None = None
        for _ in range(25):
            try:
                self.client.health()
            except Exception as error:  # any failure means not yet
                last_error = error
                time.sleep(0.2)
            else:
                return
        message = f"the container is up but {self.base_url} does not answer"
        raise OrcidMockStartError(message) from last_error

    def _discard(self) -> str:
        """After a failed start: the tail of the container's output, and the container removed.

        The server's own message (a users file it rejected, say) is in that output. Touches only
        the container this start created.
        """
        container = self._container
        if container is None:
            return ""
        self._container = None
        self._client = None
        try:
            output = container.logs(tail=_LOG_TAIL_LINES).decode(errors="replace").strip()
        except Exception:  # the container may already be gone
            output = ""
        with contextlib.suppress(Exception):  # nothing left to clean up
            container.remove(force=True, v=True)
        return output
