from pathlib import Path
import json
import tempfile
import unittest
from unittest import mock

from upload_qiniu_release import main, release_upload_plan


class UploadPlanTest(unittest.TestCase):
    def test_assets_are_versioned_before_stable_manifests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "miniQ_1.2.3_x64-setup.exe").write_bytes(b"installer")
            (root / "latest.json").write_text("{}", encoding="utf-8")
            (root / "latest.github.json").write_text("{}", encoding="utf-8")

            plan = release_upload_plan(root, "v1.2.3")

            self.assertEqual(
                [item.object_key for item in plan],
                [
                    "releases/miniq/v1.2.3/latest.json",
                    "releases/miniq/v1.2.3/miniQ_1.2.3_x64-setup.exe",
                    "releases/miniq/latest.json",
                    "latest.json",
                ],
            )

    def test_latest_manifest_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "latest.json"):
                release_upload_plan(Path(directory), "v1.2.3")

    def test_semantic_version_tag_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "latest.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "invalid release tag"):
                release_upload_plan(root, "release-1.2")


class PublicationTest(unittest.TestCase):
    def run_publication(self, changed=False, invalid=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "latest.json").write_text('{"version":"0.1.17"}', encoding="utf-8")
            writes = []

            def record(items, *_):
                writes.append([item.object_key for item in items])
                for item in items:
                    if item.object_key == "releases/manifest.json":
                        self.assertEqual(json.loads(item.source.read_text()), {"merged": True})

            with mock.patch.multiple("upload_qiniu_release", read_manifest=mock.DEFAULT,
                                     merge_manifest=mock.DEFAULT, publish=mock.DEFAULT,
                                     required_env=mock.DEFAULT, refresh_manifests=mock.DEFAULT) as mocks:
                mocks["required_env"].side_effect = lambda name: name
                mocks["read_manifest"].side_effect = [b"{}", b'{"changed":true}' if changed else b"{}"]
                mocks["merge_manifest"].return_value = {"merged": True}
                if invalid:
                    mocks["merge_manifest"].side_effect = ValueError("incomplete release")
                mocks["publish"].side_effect = record
                with mock.patch("sys.argv", ["publisher", "--input", directory, "--tag", "v0.1.17"]):
                    if invalid or changed:
                        with self.assertRaisesRegex((ValueError, RuntimeError),
                                                    "incomplete release" if invalid else "changed"):
                            main()
                    else:
                        self.assertEqual(main(), 0)
                if changed or invalid:
                    mocks["refresh_manifests"].assert_not_called()
                else:
                    mocks["refresh_manifests"].assert_called_once()
            return writes

    def test_download_manifest_is_published_after_assets_and_updater(self):
        writes = self.run_publication()
        self.assertEqual(writes[-1], ["releases/manifest.json"])
        self.assertEqual(writes[-2], ["latest.json"])

    def test_concurrent_edit_does_not_overwrite_shared_manifest(self):
        writes = self.run_publication(changed=True)
        self.assertNotIn("releases/manifest.json", [key for batch in writes for key in batch])

    def test_invalid_metadata_stops_before_any_upload(self):
        self.assertEqual(self.run_publication(invalid=True), [])


if __name__ == "__main__":
    unittest.main()
