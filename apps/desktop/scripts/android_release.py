"""Validate, sign-check and publish Android releases without touching desktop metadata."""

from __future__ import annotations

import argparse
import base64
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.request import Request, urlopen
import uuid

from upload_qiniu_release import UploadItem, publish, required_env

ROOT = Path(__file__).resolve().parents[1]
DOMAIN = "https://oss.zaiwen.top"
MANIFEST_KEY = "releases/manifest.json"
SIGNING_CERT_SHA256 = "05D22724D2AD383290390BC1DBFB25E53940DD8FE2C45FABC065D2F0D600220C"


def version_for_tag(tag: str) -> str:
    match = re.fullmatch(r"android-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", tag)
    if not match:
        raise ValueError("expected Android-only tag android-vX.Y.Z")
    return ".".join(match.groups())


def validate_version(tag: str, gradle: str) -> str:
    version = version_for_tag(tag)
    names = re.findall(r'^\s*versionName\s+"([^"]+)"', gradle, re.M)
    codes = re.findall(r"^\s*versionCode\s+(\d+)\s*$", gradle, re.M)
    if names != [version] or len(codes) != 1 or int(codes[0]) <= 0:
        raise ValueError("Android tag does not match Gradle versionName/versionCode")
    if version == "0.1.17" and codes != ["17"]:
        raise ValueError("Android 0.1.17 requires versionCode 17")
    return version


def prepare_signing() -> Path:
    names = ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]
    values = {name: required_env(name) for name in names}
    data = base64.b64decode(values["ANDROID_KEYSTORE_BASE64"], validate=True)
    if not data:
        raise ValueError("empty Android keystore")
    path = Path(required_env("RUNNER_TEMP")) / "miniq-android-release.keystore"
    with path.open("xb") as output:
        os.chmod(path, 0o600)
        output.write(data)
    with Path(required_env("GITHUB_ENV")).open("a") as output:
        output.write(f"ANDROID_KEYSTORE_PATH={path}\n")
    return path


def verify_apk(apk: Path, tag: str, tools: Path) -> None:
    version = validate_version(tag, (ROOT / "android/app/build.gradle").read_text())
    signing = subprocess.run([str(tools / "apksigner"), "verify", "--verbose", "--print-certs", str(apk)],
                             check=True, capture_output=True, text=True).stdout
    if not re.search(r"Signer #\d+ certificate DN:", signing) or re.search(r"Android Debug", signing, re.I):
        raise ValueError("APK must have a non-debug signing certificate")
    fingerprints = re.findall(r"Signer #\d+ certificate SHA-256 digest:\s*([0-9a-fA-F:]+)", signing)
    if not fingerprints or any(value.replace(":", "").upper() != SIGNING_CERT_SHA256 for value in fingerprints):
        raise ValueError("APK signing certificate does not match the pinned Android release certificate")
    badging = subprocess.run([str(tools / "aapt"), "dump", "badging", str(apk)],
                             check=True, capture_output=True, text=True).stdout
    code = re.search(r"versionCode\s+(\d+)", (ROOT / "android/app/build.gradle").read_text()).group(1)
    if ("application-debuggable" in badging or f"versionName='{version}'" not in badging
            or f"versionCode='{code}'" not in badging or "name='com.leadingthink.miniq'" not in badging):
        raise ValueError("APK identity/version/debuggable verification failed")


def merge_manifest(current: dict, version: str, digest: str, size: int, date: str) -> dict:
    result = copy.deepcopy(current)
    try:
        platforms = result["products"]["miniq"]["platforms"]
        if not isinstance(platforms, dict):
            raise TypeError()
        android = platforms.get("android", {})
        if not isinstance(android, dict):
            raise TypeError()
    except (KeyError, TypeError):
        raise ValueError("remote manifest must contain products.miniq.platforms object") from None
    platforms["android"] = {
        **android,
        "version": version,
        "releaseDate": date,
        "status": "available",
        "url": f"{DOMAIN}/releases/miniq/android/v{version}/miniQ_{version}_android.apk",
        "sha256": digest,
        "fileSize": size,
        "minAndroidVersion": "Android 7.0 (API 24)",
        "installationNotes": [
            "需要 Android 7.0 或更高版本。",
            "下载 APK 后打开安装；如系统提示，请允许浏览器或文件管理器安装未知来源应用。",
            "旧版调试签名应用无法直接覆盖安装，请先备份所需数据再卸载旧版；卸载会清除应用本地数据。",
            "后续正式版本可直接覆盖升级，请仅从官方渠道下载。",
        ],
    }
    return result


def read_remote(key: str) -> bytes:
    request = Request(f"{DOMAIN}/{key}?release_check={uuid.uuid4().hex}", headers={"Cache-Control": "no-cache"})
    with urlopen(request, timeout=120) as response:
        return response.read()


def publish_android(apk: Path, tag: str) -> None:
    version = validate_version(tag, (ROOT / "android/app/build.gradle").read_text())
    if apk.name != f"miniQ_{version}_android.apk" or not apk.is_file():
        raise ValueError("expected versioned Android APK")
    credentials = (required_env("QINIU_BUCKET"), required_env("QINIU_ACCESS_KEY"), required_env("QINIU_SECRET_KEY"))
    original = read_remote(MANIFEST_KEY)
    current = json.loads(original)
    data = apk.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    metadata = merge_manifest(current, version, digest, len(data), datetime.now(timezone.utc).isoformat())
    key = f"releases/miniq/android/v{version}/{apk.name}"
    publish([UploadItem(apk, key)], *credentials)
    remote = read_remote(key)
    if len(remote) != len(data) or hashlib.sha256(remote).hexdigest() != digest:
        raise RuntimeError("uploaded APK download does not match local SHA-256/size")
    if read_remote(MANIFEST_KEY) != original:
        raise RuntimeError("shared manifest changed during publication; retry from current metadata")
    with tempfile.TemporaryDirectory() as directory:
        manifest = Path(directory) / "manifest.json"
        manifest.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
        publish([UploadItem(manifest, MANIFEST_KEY)], *credentials)
    from qiniu import Auth, CdnManager
    result, response = CdnManager(Auth(credentials[1], credentials[2])).refresh_urls([f"{DOMAIN}/{MANIFEST_KEY}"])
    if response.status_code != 200 or not result or result.get("code", 200) != 200:
        raise RuntimeError("Android manifest CDN refresh failed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["validate", "prepare-signing", "verify", "publish"])
    parser.add_argument("--tag")
    parser.add_argument("--apk", type=Path)
    parser.add_argument("--tools", type=Path)
    args = parser.parse_args()
    if args.action == "prepare-signing":
        prepare_signing()
        return
    if not args.tag:
        parser.error("--tag is required")
    validate_version(args.tag, (ROOT / "android/app/build.gradle").read_text())
    if args.action in ("verify", "publish") and not args.apk:
        parser.error("--apk is required")
    if args.action == "verify":
        if not args.tools:
            parser.error("--tools is required")
        verify_apk(args.apk, args.tag, args.tools)
    elif args.action == "publish":
        publish_android(args.apk, args.tag)


if __name__ == "__main__":
    main()
