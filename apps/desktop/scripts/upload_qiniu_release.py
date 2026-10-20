"""Upload a complete miniQ release to its Qiniu primary origin."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from desktop_download_manifest import MANIFEST_KEY, merge_manifest, read_manifest


@dataclass(frozen=True)
class UploadItem:
    source: Path
    object_key: str


def release_upload_plan(input_dir: Path, tag: str, mode: str = "stable") -> list[UploadItem]:
    source_dir = input_dir.resolve()
    if not source_dir.is_dir():
        raise ValueError(f"release directory does not exist: {source_dir}")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError(f"invalid release tag: {tag}")
    if mode not in {"draft", "stable"}:
        raise ValueError(f"invalid release mode: {mode}")

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
    if mode == "draft":
        return versioned

    terminal = source_dir / "terminal.json"
    terminal_stable = []
    if terminal in files:
        for name in ("install.sh", "install.ps1", "terminal.json"):
            source = source_dir / name
            if source not in files:
                raise ValueError(f"terminal release must contain {name}")
            terminal_stable.append(UploadItem(source, f"releases/miniq/{name}"))
    # Stable manifests are uploaded last, so clients never see metadata before assets exist.
    return versioned + terminal_stable + [
        UploadItem(latest, "releases/miniq/latest.json"),
        UploadItem(latest, "latest.json"),
    ]


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def failure_details(status_code: int, exception: BaseException | None) -> str:
    error_types = []
    seen = set()
    while exception is not None and id(exception) not in seen:
        seen.add(id(exception))
        error_types.append(type(exception).__name__)
        exception = exception.__cause__ or exception.__context__
    detail = f"status={status_code}"
    if error_types:
        detail += f", error={' -> '.join(error_types)}"
    return detail


@contextmanager
def qiniu_operation(operation: str) -> Iterator[None]:
    try:
        yield
    except Exception as error:  # noqa: BLE001 - SDK errors may contain credentials.
        detail = failure_details(-1, error)
        raise RuntimeError(f"Qiniu {operation} failed ({detail})") from None


def publish(items: list[UploadItem], bucket_name: str, access_key: str, secret_key: str) -> None:
    from qiniu import Auth, BucketManager, Region, config, put_file_v2
    from qiniu.http.endpoint import Endpoint
    from qiniu.http.regions_provider import get_default_regions_provider

    # Requests uses this timeout while sending the request body as well as reading it.
    config.set_default(default_zone=Region(scheme="https"), connection_timeout=120)
    auth = Auth(access_key, secret_key)
    query_hosts = [config.get_default("default_query_region_host")]
    query_hosts.extend(config.get_default("default_query_region_backup_hosts"))
    with qiniu_operation("region discovery"):
        regions = list(get_default_regions_provider(
            query_endpoints_provider=[Endpoint.from_host(host) for host in query_hosts],
            access_key=access_key,
            bucket_name=bucket_name,
            preferred_scheme="https",
        ))
    # Explicit regions preserve discovery when the default zone only sets the scheme.
    bucket = BucketManager(auth, regions=regions, preferred_scheme="https")
    for item in items:
        size = item.source.stat().st_size
        reported_bytes = 0

        def report_progress(uploaded: int, total: int, object_key: str = item.object_key) -> None:
            nonlocal reported_bytes
            if uploaded == total or uploaded - reported_bytes >= 16 * 1024 * 1024:
                print(f"uploading {object_key}: {uploaded}/{total} bytes", flush=True)
                reported_bytes = uploaded

        print(f"uploading {item.object_key} ({size} bytes)", flush=True)
        token = auth.upload_token(bucket_name, item.object_key, 3600)
        mime_type = mimetypes.guess_type(item.source.name)[0] or "application/octet-stream"
        with qiniu_operation(f"upload {item.object_key}"):
            result, response = put_file_v2(
                token,
                item.object_key,
                str(item.source),
                check_crc=True,
                mime_type=mime_type,
                regions=regions,
                part_size=1024 * 1024,
                progress_handler=report_progress,
            )
        if response.status_code != 200 or not result or not result.get("hash"):
            detail = failure_details(response.status_code, response.exception)
            raise RuntimeError(f"Qiniu upload failed: {item.object_key} ({detail})")
        with qiniu_operation(f"verification {item.object_key}"):
            stat, stat_response = bucket.stat(bucket_name, item.object_key)
        size_matches = bool(stat and stat.get("fsize") == size)
        hash_matches = bool(stat and stat.get("hash") == result["hash"])
        if stat_response.status_code != 200 or not size_matches or not hash_matches:
            detail = failure_details(stat_response.status_code, stat_response.exception)
            detail += f", size_match={size_matches}, hash_match={hash_matches}"
            raise RuntimeError(f"Qiniu verification failed: {item.object_key} ({detail})")
        print(f"published {item.object_key} ({size} bytes)", flush=True)


def refresh_manifests(
    auth_key: str,
    secret_key: str,
    primary_domain: str,
    legacy_domain: str,
) -> None:
    from qiniu import Auth, CdnManager

    urls = [
        f"{primary_domain.rstrip('/')}/{MANIFEST_KEY}",
        f"{primary_domain.rstrip('/')}/releases/miniq/latest.json",
        f"{primary_domain.rstrip('/')}/releases/miniq/terminal.json",
        f"{primary_domain.rstrip('/')}/releases/miniq/install.sh",
        f"{primary_domain.rstrip('/')}/releases/miniq/install.ps1",
        f"{primary_domain.rstrip('/')}/latest.json",
        f"{legacy_domain.rstrip('/')}/latest.json",
    ]
    result, response = CdnManager(Auth(auth_key, secret_key)).refresh_urls(urls)
    if response.status_code != 200 or not result or result.get("code", 200) != 200:
        raise RuntimeError(f"Qiniu CDN refresh failed ({response.status_code})")
    print("refreshed miniQ stable manifests")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--mode", choices=("draft", "stable"), default="stable")
    args = parser.parse_args()

    access_key = required_env("QINIU_ACCESS_KEY")
    secret_key = required_env("QINIU_SECRET_KEY")
    bucket_name = required_env("QINIU_BUCKET")
    primary_domain = required_env("QINIU_DOMAIN")
    latest = json.loads((args.input / "latest.json").read_text(encoding="utf-8"))
    if args.mode == "draft":
        publish(release_upload_plan(args.input, args.tag, args.mode), bucket_name, access_key, secret_key)
        return 0

    legacy_bucket = required_env("QINIU_LEGACY_BUCKET")
    legacy_domain = required_env("QINIU_LEGACY_DOMAIN")
    original = read_manifest(primary_domain)
    download_manifest = merge_manifest(
        json.loads(original), latest, args.input, args.tag, primary_domain,
    )
    publish(release_upload_plan(args.input, args.tag, args.mode), bucket_name, access_key, secret_key)
    publish(
        [UploadItem(args.input.resolve() / "latest.json", "latest.json")],
        legacy_bucket,
        access_key,
        secret_key,
    )
    if read_manifest(primary_domain) != original:
        raise RuntimeError("shared download manifest changed during publication; retry from current metadata")
    with tempfile.TemporaryDirectory() as directory:
        manifest = Path(directory) / "manifest.json"
        manifest.write_text(json.dumps(download_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        publish([UploadItem(manifest, MANIFEST_KEY)], bucket_name, access_key, secret_key)
    refresh_manifests(access_key, secret_key, primary_domain, legacy_domain)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
