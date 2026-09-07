"""Merge built desktop installers into the shared download-page manifest."""

from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import re
from urllib.request import Request, urlopen
import uuid

MANIFEST_KEY = "releases/manifest.json"


def read_manifest(domain: str) -> bytes:
    request = Request(
        f"{domain.rstrip('/')}/{MANIFEST_KEY}?release_check={uuid.uuid4().hex}",
        headers={"Cache-Control": "no-cache"},
    )
    with urlopen(request, timeout=120) as response:
        return response.read()


def version_tuple(version: str) -> tuple[int, ...]:
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("expected semantic desktop version")
    return tuple(map(int, version.split(".")))


def installer_metadata(root: Path, name: str, base_url: str) -> dict:
    path = root / name
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    size = path.stat().st_size
    if not size:
        raise ValueError(f"empty installer: {name}")
    return {"url": f"{base_url}/{name}", "fileSize": size, "sha256": digest.hexdigest()}


def merge_manifest(current: dict, latest: dict, root: Path, tag: str, domain: str) -> dict:
    version = tag.removeprefix("v")
    if tag != f"v{version}" or latest.get("version") != version:
        raise ValueError("desktop tag and updater version must match")
    target_version = version_tuple(version)
    result = copy.deepcopy(current)
    try:
        product = result["products"]["miniq"]
        platforms = product["platforms"]
        if result["schemaVersion"] != 1 or not isinstance(platforms, dict):
            raise TypeError()
        if version_tuple(product["version"]) > target_version:
            raise ValueError("refusing to downgrade the shared desktop manifest")
    except (KeyError, TypeError):
        raise ValueError("remote manifest must contain products.miniq.platforms object") from None

    base_url = f"{domain.rstrip('/')}/releases/miniq/{tag}"
    mirror_url = f"https://github.com/LeadingThink/miniQ-releases/releases/download/{tag}"
    groups = {
        "windows": [("Windows", "x64", f"miniQ_{version}_x64-setup.exe")],
        "macos": [("Apple 芯片", "arm64", f"miniQ_{version}_aarch64.dmg"),
                  ("Intel 芯片", "x64", f"miniQ_{version}_x64.dmg")],
        "linux": [("AppImage", "x64", f"miniQ_{version}_x64.AppImage"),
                  ("deb", "amd64", f"miniQ_{version}_amd64.deb")],
    }
    full_release = any((root / name).exists() for items in list(groups.values())[1:]
                       for _, _, name in items)
    for platform, installers in groups.items():
        if platform != "windows" and not full_release:
            continue
        if not isinstance(platforms.get(platform), dict):
            raise ValueError(f"shared manifest is missing desktop platform: {platform}")
        downloads = [{"label": label, "architecture": arch,
                      **installer_metadata(root, name, base_url)}
                     for label, arch, name in installers]
        entry = platforms[platform]
        entry.update({**downloads[0], "label": entry["label"],
                      "architecture": entry["architecture"], "version": version,
                      "releaseDate": latest["pub_date"], "status": "available",
                      "mirrors": [f"{mirror_url}/{installers[0][2]}"]})
        if len(downloads) > 1 or "downloads" in entry:
            entry["downloads"] = downloads
    product.update({"version": version, "releaseDate": latest["pub_date"]})
    if latest.get("notes", "").strip():
        product["releaseNotes"] = latest["notes"].splitlines()
    result["publishedAt"] = latest["pub_date"]
    return result
