"""Upload a complete miniQ release to its Qiniu primary origin."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import mimetypes
import os
from pathlib import Path
import re


@dataclass(frozen=True)
class UploadItem:
    source: Path
    object_key: str


def release_upload_plan(input_dir: Path, tag: str) -> list[UploadItem]:
    source_dir = input_dir.resolve()
    if not source_dir.is_dir():
        raise ValueError(f"release directory does not exist: {source_dir}")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError(f"invalid release tag: {tag}")

    files = sorted(
        path
        for path in source_dir.iterdir()
        if path.is_file() and path.name != "latest.github.json"
    )
    latest = source_dir / "latest.json"
    if latest not in files:
        raise ValueError("release directory must contain latest.json")

    prefix = f"releases/miniq/{tag}"
    versioned = [UploadItem(path, f"{prefix}/{path.name}") for path in files]
    # Stable manifests are uploaded last, so clients never see metadata before assets exist.
    return versioned + [UploadItem(latest, "releases/miniq/latest.json")]


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def publish(items: list[UploadItem], bucket_name: str, access_key: str, secret_key: str) -> None:
    from qiniu import Auth, BucketManager, put_file_v2

    auth = Auth(access_key, secret_key)
    bucket = BucketManager(auth)
    for item in items:
        token = auth.upload_token(bucket_name, item.object_key, 3600)
        mime_type = mimetypes.guess_type(item.source.name)[0] or "application/octet-stream"
        result, response = put_file_v2(
            token,
            item.object_key,
            str(item.source),
            check_crc=True,
            mime_type=mime_type,
        )
        if response.status_code != 200 or not result:
            raise RuntimeError(f"Qiniu upload failed: {item.object_key} ({response.status_code})")
        stat, stat_response = bucket.stat(bucket_name, item.object_key)
        if (
            stat_response.status_code != 200
            or not stat
            or stat.get("fsize") != item.source.stat().st_size
        ):
            raise RuntimeError(f"Qiniu verification failed: {item.object_key}")
        print(f"published {item.object_key} ({item.source.stat().st_size} bytes)")


def refresh_manifests(
    auth_key: str,
    secret_key: str,
    primary_domain: str,
    legacy_domain: str,
) -> None:
    from qiniu import Auth, CdnManager

    urls = [
        f"{primary_domain.rstrip('/')}/releases/miniq/latest.json",
        f"{legacy_domain.rstrip('/')}/latest.json",
    ]
    result, response = CdnManager(Auth(auth_key, secret_key)).refresh_urls(urls)
    if response.status_code != 200 or not result:
        raise RuntimeError(f"Qiniu CDN refresh failed ({response.status_code})")
    print("refreshed miniQ stable manifests")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()

    access_key = required_env("QINIU_ACCESS_KEY")
    secret_key = required_env("QINIU_SECRET_KEY")
    bucket_name = required_env("QINIU_BUCKET")
    primary_domain = required_env("QINIU_DOMAIN")
    legacy_bucket = required_env("QINIU_LEGACY_BUCKET")
    legacy_domain = required_env("QINIU_LEGACY_DOMAIN")
    publish(release_upload_plan(args.input, args.tag), bucket_name, access_key, secret_key)
    publish(
        [UploadItem(args.input.resolve() / "latest.json", "latest.json")],
        legacy_bucket,
        access_key,
        secret_key,
    )
    refresh_manifests(access_key, secret_key, primary_domain, legacy_domain)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
