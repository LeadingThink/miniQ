"""Mirror the pinned living-background videos to the Qiniu primary origin.

Each video is downloaded from the source origin, verified against the pinned
size and sha256, uploaded, then read back from the public domain and verified
again so the desktop app never streams an unexpected file.
"""

from __future__ import annotations

import argparse
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
    "01-spacecat": (4768744, "713f842a5e8c748e9a3b91949b648385d44209fc356efcf5ee7803ecc24274f4"),
    "02-spirits": (5009545, "4fa48c97174f782c9c7b0b47d754f16c05bac4b327a4bc40cfed16cb0c048f8a"),
    "03-deskcat": (3647314, "a7e734fe0db090cae3b3fb9f28e659f3a99ef91d83fa518ee9b6f2e547e32305"),
    "04-rooftop": (3520161, "19a9b8f828ee2c374351a1c1fc3731d39d83d555a2a8199d5e07a6ac47e418be"),
    "05-rainstore": (6025203, "5868123874a2b100a504139d86a92996789d0b477d025b4b153ee0ed3618dc1e"),
    "06-summer": (2857951, "573a1c145c1ed7f3b8382d7ca79103982bb961a8db00a98761b44d2f7ea1a394"),
    "07-station": (4094741, "8741c9562498c6667a6643dec88c35755795858fdfe8a27086fbce7b7fdb76ad"),
    "08-mecha": (3736581, "8b1fc951660cecf692bc88a04c06887398cf4c1ecb34bba415fe2fcefd1ad87c"),
    "09-nightcar": (4434556, "ed0866f72c701507f9873df16f284f089a3bc9907077bef1715aebd0f2d27282"),
    "10-space": (5127241, "7f53f496172b3405b966122ef92b1fb676d7821a145aa78b561b9dad886595d9"),
    "11-gameroom": (3591412, "679f31249c1316a3adc7420348c792e78a6060303f7edfa4c0127d8b21551b3a"),
    "12-pixelcamp": (5326482, "96555097624ab2cc72b284520cfffba68d57f18186e10827e26d264c1214961b"),
    "13-court": (4178502, "3b7cc26d11b6e7b9ec656f506cc1735eddc4956880d740b592a9b655b14600dd"),
    "14-fishing": (5131507, "559379cf0235be4ee9e19580f80d68d730bc0c53dedb0a6c984e6f05ec37b3c2"),
}


def object_key(background_id: str) -> str:
    return f"{OBJECT_PREFIX}/{background_id}.mp4"


def verify_bytes(background_id: str, data: bytes) -> None:
    size, digest = BACKGROUND_VIDEOS[background_id]
    if len(data) != size:
        raise ValueError(f"{background_id}: expected {size} bytes, got {len(data)}")
    actual = hashlib.sha256(data).hexdigest()
    if actual != digest:
        raise ValueError(f"{background_id}: sha256 mismatch ({actual})")


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "miniq-background-publisher"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def download_sources(source_origin: str, target: Path) -> list[UploadItem]:
    items = []
    for background_id in BACKGROUND_VIDEOS:
        data = fetch(f"{source_origin}/{object_key(background_id)}")
        verify_bytes(background_id, data)
        path = target / f"{background_id}.mp4"
        path.write_bytes(data)
        items.append(UploadItem(path, object_key(background_id)))
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
    for background_id in BACKGROUND_VIDEOS:
        verify_bytes(background_id, fetch(f"{domain}/{object_key(background_id)}"))
        print(f"verified {domain}/{object_key(background_id)}")


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
