from pathlib import Path
import re
import unittest

from upload_qiniu_backgrounds import BACKGROUND_VIDEOS, assets, object_key, verify_bytes

CATALOG = Path(__file__).resolve().parent.parent / "src" / "backgroundCatalog.ts"


class BackgroundVideoManifestTest(unittest.TestCase):
    def test_manifest_matches_the_app_catalog(self) -> None:
        catalog = CATALOG.read_text(encoding="utf-8")
        video_ids = re.findall(r'id: "(\d\d-[a-z]+)"', catalog)
        self.assertEqual(sorted(video_ids), sorted(BACKGROUND_VIDEOS))

    def test_object_keys_match_the_app_url_layout(self) -> None:
        self.assertEqual(object_key("14-fishing"), "themes/backgrounds/14-fishing.mp4")
        self.assertEqual(len(assets()), len(BACKGROUND_VIDEOS))

    def test_rejects_unexpected_content(self) -> None:
        size, _ = BACKGROUND_VIDEOS["14-fishing"]
        with self.assertRaisesRegex(ValueError, "sha256"):
            verify_bytes("14-fishing", b"\0" * size)
        with self.assertRaisesRegex(ValueError, "bytes"):
            verify_bytes("14-fishing", b"short")

    def test_digests_are_well_formed(self) -> None:
        for size, digest in BACKGROUND_VIDEOS.values():
            self.assertGreater(size, 0)
            self.assertRegex(digest, r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
