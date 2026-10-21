"""Mirror the pinned living-background assets to the Qiniu primary origin.

Each asset is downloaded from the source origin, verified against the pinned
size and sha256, uploaded, then read back from the public domain and verified
again so the desktop app never streams an unexpected file.

The remaining remote wallpaper is mirrored from ``themes/backgrounds``.
Bundled quiet wallpapers ship with the desktop and mobile applications and
do not belong in this remote asset publisher.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
from pathlib import Path
import tempfile
import time
import urllib.request

from upload_qiniu_release import UploadItem, publish, required_env

UPLOAD_ATTEMPTS = 4
OBJECT_PREFIX = "themes/backgrounds"
SOURCE_ORIGIN = "https://chat.zaiwenai.com"

# id -> (size in bytes, sha256)
BACKGROUND_VIDEOS: dict[str, tuple[int, str]] = {
    "14-fishing": (5131507, "559379cf0235be4ee9e19580f80d68d730bc0c53dedb0a6c984e6f05ec37b3c2"),
}


@dataclass(frozen=True)
class Asset:
    name: str
    source_path: str
    object_key: str
    size: int
    digest: str


def object_key(background_id: str) -> str:
    return f"{OBJECT_PREFIX}/{background_id}.mp4"


def assets() -> list[Asset]:
    return [
        Asset(background_id, object_key(background_id), object_key(background_id), size, digest)
        for background_id, (size, digest) in BACKGROUND_VIDEOS.items()
    ]


def verify_asset(asset: Asset, data: bytes) -> None:
    if len(data) != asset.size:
        raise ValueError(f"{asset.name}: expected {asset.size} bytes, got {len(data)}")
    actual = hashlib.sha256(data).hexdigest()
    if actual != asset.digest:
        raise ValueError(f"{asset.name}: sha256 mismatch ({actual})")


def verify_bytes(background_id: str, data: bytes) -> None:
    size, digest = BACKGROUND_VIDEOS[background_id]
    verify_asset(Asset(background_id, "", "", size, digest), data)


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "miniq-background-publisher"})
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == 3:
                raise
            print(f"retrying source download after attempt {attempt}: {url} ({error})")
            time.sleep(10 * attempt)


def download_sources(source_origin: str, target: Path) -> list[UploadItem]:
    items = []
    for index, asset in enumerate(assets()):
        data = fetch(f"{source_origin}/{asset.source_path}")
        verify_asset(asset, data)
        path = target / f"{index:03d}-{Path(asset.object_key).name}"
        path.write_bytes(data)
        items.append(UploadItem(path, asset.object_key))
    return items


def publish_with_retry(
    items: list[UploadItem], bucket_name: str, access_key: str, secret_key: str
) -> None:
    for item in items:
        for attempt in range(1, UPLOAD_ATTEMPTS + 1):
            try:
                publish([item], bucket_name, access_key, secret_key)
                break
            except RuntimeError as error:
                if attempt == UPLOAD_ATTEMPTS:
                    raise
                print(f"retrying {item.object_key} after attempt {attempt}: {error}")
                time.sleep(5 * attempt)


def verify_public(domain: str) -> None:
    for asset in assets():
        verify_asset(asset, fetch(f"{domain}/{asset.object_key}"))
        print(f"verified {domain}/{asset.object_key}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-origin", default=SOURCE_ORIGIN)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    domain = required_env("QINIU_DOMAIN").rstrip("/")
    if not args.verify_only:
        with tempfile.TemporaryDirectory() as directory:
            items = download_sources(args.source_origin.rstrip("/"), Path(directory))
            publish_with_retry(
                items,
                required_env("QINIU_BUCKET"),
                required_env("QINIU_ACCESS_KEY"),
                required_env("QINIU_SECRET_KEY"),
            )
    verify_public(domain)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
