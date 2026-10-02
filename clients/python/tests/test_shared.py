"""Which image a container runs. Pure functions and the environment, with real inputs."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from orcid_mock._shared import IMAGE_REPOSITORY, default_image, image_tag, resolve_image


@pytest.mark.parametrize(
    ("package_version", "tag"),
    [
        ("1.2.3", "1.2.3"),
        ("1.2.3rc1", "1.2.3-rc.1"),
        ("1.2.3a2", "1.2.3-alpha.2"),
        ("1.2.3b10", "1.2.3-beta.10"),
        ("0.0.0", "0.0.0"),
        # Anything PEP 440 allows beyond those forms is passed through, never guessed at.
        ("1.2.3.post1", "1.2.3.post1"),
        ("1.2.3.dev4", "1.2.3.dev4"),
    ],
)
def test_image_tag_spells_a_prerelease_the_way_the_server_does(
    package_version: str, tag: str
) -> None:
    assert image_tag(package_version) == tag


def test_the_default_image_is_the_servers_version_since_helpers_release_in_lockstep(
    repo_root: Path,
) -> None:
    server = json.loads((repo_root / "package.json").read_text(encoding="utf-8"))["version"]
    assert default_image() == f"{IMAGE_REPOSITORY}:{server}"
    assert IMAGE_REPOSITORY == "ghcr.io/nemarorg/orcid-mock"


def test_an_option_wins_over_the_environment_which_wins_over_the_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ORCID_MOCK_IMAGE", raising=False)
    assert resolve_image() == default_image()
    assert resolve_image("mine:1") == "mine:1"

    monkeypatch.setenv("ORCID_MOCK_IMAGE", "from-env:2")
    assert resolve_image() == "from-env:2"
    assert resolve_image("mine:1") == "mine:1"

    monkeypatch.setenv("ORCID_MOCK_IMAGE", "")
    assert resolve_image() == default_image()
