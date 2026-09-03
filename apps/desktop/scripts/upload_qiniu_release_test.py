from pathlib import Path
import tempfile
import unittest

from upload_qiniu_release import release_upload_plan


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


if __name__ == "__main__":
    unittest.main()
