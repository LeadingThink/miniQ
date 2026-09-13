"""Focused Android-only release regression tests; no network or signing keys required."""

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import android_release as release


class AndroidReleaseTests(unittest.TestCase):
    def setUp(self):
        self.current = {"version": "schema-1", "products": {
            "app": {"version": "9", "platforms": {"android": {"url": "app.apk"}}},
            "miniq": {"version": "0.1.16", "history": ["0.1.15"], "platforms": {
                "windows": {"version": "0.1.16", "url": "desktop.exe"},
                "android": {"status": "coming-soon", "custom": "retained"},
            }},
        }}

    def test_merge_preserves_other_products_versions_and_platforms(self):
        before = copy.deepcopy(self.current)
        merged = release.merge_manifest(self.current, "0.1.19", "a" * 64, 42, "2026-01-01")
        self.assertEqual(self.current, before)
        android = merged["products"]["miniq"]["platforms"]["android"]
        self.assertEqual(android["sha256"], "a" * 64)
        self.assertEqual(android["fileSize"], 42)
        self.assertEqual(android["custom"], "retained")
        self.assertIsInstance(android["installationNotes"], list)
        self.assertTrue(all(isinstance(note, str) and note for note in android["installationNotes"]))
        self.assertEqual(android["minAndroidVersion"], "Android 7.0 (API 24)")
        self.assertEqual(android["url"], "https://oss.zaiwen.top/releases/miniq/android/v0.1.19/miniQ_0.1.19_android.apk")
        merged["products"]["miniq"]["platforms"]["android"] = before["products"]["miniq"]["platforms"]["android"]
        self.assertEqual(merged, before)

    def test_invalid_tags_and_gradle_mismatch(self):
        gradle = (release.ROOT / "android/app/build.gradle").read_text()
        self.assertEqual(release.validate_version("android-v0.1.19", gradle), "0.1.19")
        for tag in ["v0.1.19", "android-v01.1.17", "android-v0.1.19-beta", "android-v0.1.19\n", "android-v0.1.17", "main", "$(id)"]:
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.validate_version(tag, gradle)
        with self.assertRaises(ValueError):
            release.validate_version("android-v0.1.19", gradle.replace('versionName "0.1.19"', 'versionName "0.1.17"'))

    def test_malformed_manifest_fails_closed(self):
        for current in [{}, {"products": {}}, {"products": {"miniq": {"platforms": []}}}]:
            with self.assertRaises(ValueError):
                release.merge_manifest(current, "0.1.19", "a" * 64, 1, "date")

    def test_each_missing_signing_secret_fails_before_writing(self):
        env = {name: "value" for name in ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]}
        for missing in env:
            with patch.dict(os.environ, {k: v for k, v in env.items() if k != missing}, clear=True):
                with self.assertRaisesRegex(RuntimeError, missing):
                    release.prepare_signing()

    def test_invalid_base64_fails_closed(self):
        with patch.dict(os.environ, {"ANDROID_KEYSTORE_BASE64": "!invalid!", "ANDROID_KEYSTORE_PASSWORD": "x", "ANDROID_KEY_ALIAS": "x", "ANDROID_KEY_PASSWORD": "x"}, clear=True):
            with self.assertRaises(ValueError):
                release.prepare_signing()

    def test_apk_debug_certificate_and_debuggable_rejected(self):
        valid = f"Signer #1 certificate DN: CN=miniQ Release\nSigner #1 certificate SHA-256 digest: {release.SIGNING_CERT_SHA256}"
        badging = "package: name='com.leadingthink.miniq' versionCode='19' versionName='0.1.19'"
        for certificate, package in [("Signer #1 certificate DN: CN=Android Debug", badging), (valid, badging + "\napplication-debuggable"), ("", badging)]:
            outputs = [subprocess.CompletedProcess([], 0, certificate), subprocess.CompletedProcess([], 0, package)]
            with patch.object(release.subprocess, "run", side_effect=outputs), self.assertRaises(ValueError):
                release.verify_apk(Path("release.apk"), "android-v0.1.19", Path("tools"))

    def test_apk_certificate_must_match_pinned_production_key(self):
        badging = "package: name='com.leadingthink.miniq' versionCode='19' versionName='0.1.19'"
        for digest in [None, "a" * 64, release.SIGNING_CERT_SHA256.lower()]:
            signing = "Signer #1 certificate DN: CN=miniQ Release"
            if digest:
                signing += f"\nSigner #1 certificate SHA-256 digest: {digest}"
            outputs = [subprocess.CompletedProcess([], 0, signing), subprocess.CompletedProcess([], 0, badging)]
            with self.subTest(digest=digest), patch.object(release.subprocess, "run", side_effect=outputs):
                if digest == release.SIGNING_CERT_SHA256.lower():
                    release.verify_apk(Path("release.apk"), "android-v0.1.19", Path("tools"))
                else:
                    with self.assertRaisesRegex(ValueError, "pinned"):
                        release.verify_apk(Path("release.apk"), "android-v0.1.19", Path("tools"))

    def test_failed_manifest_read_never_uploads(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "miniQ_0.1.19_android.apk"
            apk.write_bytes(b"apk")
            with patch.object(release, "required_env", return_value="unused"), patch.object(release, "read_remote", side_effect=OSError("offline")), patch.object(release, "publish") as upload:
                with self.assertRaises(OSError):
                    release.publish_android(apk, "android-v0.1.19")
                upload.assert_not_called()

    def test_apk_verified_before_shared_manifest_and_no_latest_json(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "miniQ_0.1.19_android.apk"
            apk.write_bytes(b"apk")
            original = json.dumps(self.current).encode()
            uploads = []
            def upload(items, *credentials):
                uploads.extend(item.object_key for item in items)
            with patch.object(release, "required_env", return_value="unused"), patch.object(release, "read_remote", side_effect=[original, b"corrupted"]), patch.object(release, "publish", side_effect=upload):
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    release.publish_android(apk, "android-v0.1.19")
            self.assertEqual(uploads, ["releases/miniq/android/v0.1.19/miniQ_0.1.19_android.apk"])

    def test_concurrent_manifest_change_aborts_metadata_write(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "miniQ_0.1.19_android.apk"
            apk.write_bytes(b"apk")
            original = json.dumps(self.current).encode()
            with patch.object(release, "required_env", return_value="unused"), patch.object(release, "read_remote", side_effect=[original, b"apk", b"changed"]), patch.object(release, "publish") as upload:
                with self.assertRaisesRegex(RuntimeError, "changed"):
                    release.publish_android(apk, "android-v0.1.19")
                self.assertEqual(upload.call_count, 1)

    def test_success_only_uploads_android_apk_then_merged_shared_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "miniQ_0.1.19_android.apk"
            apk.write_bytes(b"apk")
            original = json.dumps(self.current).encode()
            events = []
            responses = iter([original, b"apk", original])

            def read(key):
                events.append(("read", key))
                return next(responses)

            def upload(items, *credentials):
                for item in items:
                    events.append(("upload", item.object_key))
                    if item.object_key == release.MANIFEST_KEY:
                        metadata = json.loads(item.source.read_text())
                        android = metadata["products"]["miniq"]["platforms"]["android"]
                        self.assertEqual(android["sha256"], hashlib.sha256(b"apk").hexdigest())
                        metadata["products"]["miniq"]["platforms"]["android"] = self.current["products"]["miniq"]["platforms"]["android"]
                        self.assertEqual(metadata, self.current)

            def refresh(urls):
                self.assertEqual(urls, ["https://oss.zaiwen.top/releases/manifest.json"])
                return {"code": 200}, SimpleNamespace(status_code=200)

            qiniu = SimpleNamespace(Auth=lambda *args: None, CdnManager=lambda auth: SimpleNamespace(refresh_urls=refresh))
            with patch.object(release, "required_env", return_value="unused"), patch.object(release, "read_remote", side_effect=read), patch.object(release, "publish", side_effect=upload), patch.dict(sys.modules, {"qiniu": qiniu}):
                release.publish_android(apk, "android-v0.1.19")
            key = "releases/miniq/android/v0.1.19/miniQ_0.1.19_android.apk"
            self.assertEqual(events, [("read", release.MANIFEST_KEY), ("upload", key), ("read", key), ("read", release.MANIFEST_KEY), ("upload", release.MANIFEST_KEY)])

    def test_workflow_keeps_desktop_default_and_isolates_android(self):
        workflow = (release.ROOT.parents[1] / ".github/workflows/release.yml").read_text()
        self.assertIn("default: desktop", workflow)
        self.assertIn("if: ${{ inputs.platform != 'android' }}", workflow)
        android = workflow.split("\n  android:\n", 1)[1]
        self.assertIn("if: ${{ inputs.platform == 'android' }}", android)
        self.assertNotIn("latest.json", android)
        self.assertNotIn("tauri", android)
        self.assertIn("--latest=false", android)
        self.assertIn("fetch-depth: 0", android)
        self.assertIn('if [ "$RELEASE_DRAFT" != "false" ]; then', android)
        self.assertLess(android.index("Reject Android draft publication"), android.index("actions/checkout@v4"))
        guard = android.split("actions/checkout@v4", 1)[0]
        self.assertIn("working-directory: ${{ github.workspace }}", guard)
        gradle = (release.ROOT / "android/app/build.gradle").read_text()
        self.assertIn("throw new GradleException", gradle)
        self.assertIn("signingConfig signingConfigs.release", gradle)
        self.assertIn("debuggable false", gradle)


if __name__ == "__main__":
    unittest.main()
