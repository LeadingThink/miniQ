import copy
import hashlib
from pathlib import Path
import tempfile
import unittest

from desktop_download_manifest import merge_manifest


class DesktopManifestTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.current = {
            "schemaVersion": 1, "products": {
                "app": {"version": "1.1.5", "platforms": {"android": {"url": "app.apk"}}},
                "miniq": {"version": "0.1.12", "forceUpdate": False, "platforms": {
                    "windows": {"label": "Windows", "architecture": "x64", "url": "old.exe"},
                    "macos": {"label": "macOS", "architecture": "arm64 / x64",
                              "installationNotes": ["unsigned preview"]},
                    "linux": {"label": "Linux", "architecture": "x64"},
                    "android": {"version": "0.1.17", "url": "android.apk"},
                    "ios": {"status": "coming_soon"},
                }},
            },
        }
        self.latest = {"version": "0.1.17", "notes": "Retry fix\nProject directories",
                       "pub_date": "2026-09-08T00:00:00Z"}
        self.suffixes = ["x64-setup.exe", "aarch64.dmg", "x64.dmg", "x64.AppImage", "amd64.deb"]
        for suffix in self.suffixes:
            (self.root / f"miniQ_0.1.17_{suffix}").write_bytes(suffix.encode())

    def merge(self):
        return merge_manifest(self.current, self.latest, self.root, "v0.1.17", "https://oss.zaiwen.top")

    def test_updates_all_desktop_downloads_with_actual_hashes(self):
        result = self.merge()
        product = result["products"]["miniq"]
        self.assertEqual(product["version"], "0.1.17")
        self.assertEqual(product["releaseNotes"], ["Retry fix", "Project directories"])
        for platform in ("windows", "macos", "linux"):
            entry = product["platforms"][platform]
            self.assertIn("/v0.1.17/", entry["url"])
            self.assertIn("/v0.1.17/", entry["mirrors"][0])
            for download in entry.get("downloads", [entry]):
                name = download["url"].split("/")[-1]
                data = (self.root / name).read_bytes()
                self.assertEqual(download["fileSize"], len(data))
                self.assertEqual(download["sha256"], hashlib.sha256(data).hexdigest())

    def test_preserves_mobile_other_products_and_installation_notes(self):
        original = copy.deepcopy(self.current)
        result = self.merge()
        self.assertEqual(self.current, original)
        self.assertEqual(result["products"]["app"], original["products"]["app"])
        for platform in ("android", "ios"):
            self.assertEqual(result["products"]["miniq"]["platforms"][platform],
                             original["products"]["miniq"]["platforms"][platform])
        self.assertEqual(result["products"]["miniq"]["platforms"]["macos"]["installationNotes"],
                         ["unsigned preview"])

    def test_windows_only_preserves_other_desktop_downloads(self):
        for suffix in self.suffixes[1:]:
            (self.root / f"miniQ_0.1.17_{suffix}").unlink()
        result = self.merge()
        for platform in ("macos", "linux"):
            self.assertEqual(result["products"]["miniq"]["platforms"][platform],
                             self.current["products"]["miniq"]["platforms"][platform])

    def test_windows_and_macos_preserve_linux_downloads(self):
        for suffix in self.suffixes[-2:]:
            (self.root / f"miniQ_0.1.17_{suffix}").unlink()
        result = self.merge()
        self.assertEqual(result["products"]["miniq"]["platforms"]["linux"],
                         self.current["products"]["miniq"]["platforms"]["linux"])
        self.assertIn("/v0.1.17/", result["products"]["miniq"]["platforms"]["macos"]["url"])

    def test_incomplete_full_release_fails(self):
        (self.root / "miniQ_0.1.17_x64.dmg").unlink()
        with self.assertRaises(FileNotFoundError):
            self.merge()

    def test_empty_installer_fails(self):
        (self.root / "miniQ_0.1.17_x64-setup.exe").write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "empty installer"):
            self.merge()

    def test_downgrade_fails(self):
        self.current["products"]["miniq"]["version"] = "0.2.0"
        with self.assertRaisesRegex(ValueError, "downgrade"):
            self.merge()

    def test_version_mismatch_fails(self):
        self.latest["version"] = "0.1.16"
        with self.assertRaisesRegex(ValueError, "must match"):
            self.merge()

    def test_malformed_remote_manifest_fails(self):
        self.current["products"]["miniq"]["platforms"] = []
        with self.assertRaisesRegex(ValueError, "platforms object"):
            self.merge()


if __name__ == "__main__":
    unittest.main()
