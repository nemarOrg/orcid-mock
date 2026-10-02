"""What every helper agrees on: which image to run and when to use a running instance instead."""

from __future__ import annotations

import os
import re
from importlib.metadata import PackageNotFoundError, version

IMAGE_REPOSITORY = "ghcr.io/nemarorg/orcid-mock"
"""The image repository without a tag."""

CONTAINER_PORT = 9700
"""The port the mock listens on inside the container, fixed by the image."""

CONTAINER_USERS_PATH = "/fixtures/users.json"
"""Where a users file lands inside the container."""

# PEP 440 spells a prerelease 1.2.3rc1; the server's version, its image tag, and the git tag spell
# it 1.2.3-rc.1. Only these three forms are allowed in a lockstep release.
_PRERELEASE_WORDS = {"a": "alpha", "b": "beta", "rc": "rc"}
_PEP440_PRERELEASE = re.compile(r"^(\d+\.\d+\.\d+)(?:(a|b|rc)(\d+))?$")


def image_tag(package_version: str) -> str:
    """The image tag for a package version: PEP 440's ``1.2.3rc1`` becomes ``1.2.3-rc.1``."""
    match = _PEP440_PRERELEASE.match(package_version)
    if match is None:
        return package_version
    release, word, number = match.groups()
    return release if word is None else f"{release}-{_PRERELEASE_WORDS[word]}.{number}"


def package_version() -> str:
    """This package's own version, which is the server's, since helpers release in lockstep."""
    try:
        return version("orcid-mock-testing")
    except PackageNotFoundError:  # pragma: no cover - only an uninstalled source tree
        return "0.0.0"


def default_image() -> str:
    """The image that matches this package's version."""
    return f"{IMAGE_REPOSITORY}:{image_tag(package_version())}"


def resolve_image(option: str | None = None) -> str:
    """An explicit option wins over ``ORCID_MOCK_IMAGE``, which wins over the default."""
    if option:
        return option
    return os.environ.get("ORCID_MOCK_IMAGE") or default_image()


def url_from_env() -> str | None:
    """The address of a running instance from ``ORCID_MOCK_URL`` (the GitHub Action sets it)."""
    return os.environ.get("ORCID_MOCK_URL") or None
