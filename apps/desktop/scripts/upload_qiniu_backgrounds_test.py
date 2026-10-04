from pathlib import Path
import re
import unittest

from upload_qiniu_backgrounds import (
    BACKGROUND_VIDEOS,
    LIVING_PACK_ASSETS,
    assets,
    living_object_key,
    object_key,
    verify_bytes,
)

CATALOG = Path(__file__).resolve().parent.parent / "src" / "backgroundCatalog.ts"


class BackgroundVideoManifestTest(unittest.TestCase):
    def test_manifest_matches_the_app_catalog(self) -> None:
        catalog = CATALOG.read_text(encoding="utf-8")
        video_ids = re.findall(r'wallpaper\("(\d\d-[a-z]+)"', catalog)
        self.assertEqual(sorted(video_ids), sorted(BACKGROUND_VIDEOS))

    def test_living_pack_matches_the_app_catalog(self) -> None:
        catalog = CATALOG.read_text(encoding="utf-8")
        living_ids = re.findall(r'livingWallpaper\("(w\d{3}-[a-z-]+)"', catalog)
        self.assertEqual(len(living_ids), 20)
        expected = sorted(
            f"{living_id}{suffix}" for living_id in living_ids for suffix in (".mp4", "-poster.jpg", "-thumb.jpg")
        )
        self.assertEqual(expected, sorted(LIVING_PACK_ASSETS))

    def test_object_keys_match_the_app_url_layout(self) -> None:
        self.assertEqual(object_key("01-spacecat"), "themes/backgrounds/01-spacecat.mp4")
        self.assertEqual(
            living_object_key("w001-lighthouse.mp4"),
            "web/wallpapers/living/pack-01/w001-lighthouse.mp4",
        )
        sources = {asset.name: asset.source_path for asset in assets()}
        self.assertEqual(sources["w001-lighthouse.mp4"], "media/living/pack-01/w001-lighthouse.mp4")
        self.assertEqual(len(assets()), len(BACKGROUND_VIDEOS) + len(LIVING_PACK_ASSETS))

    def test_rejects_unexpected_content(self) -> None:
        size, _ = BACKGROUND_VIDEOS["06-summer"]
        with self.assertRaisesRegex(ValueError, "sha256"):
            verify_bytes("06-summer", b"\0" * size)
        with self.assertRaisesRegex(ValueError, "bytes"):
            verify_bytes("06-summer", b"short")

    def test_digests_are_well_formed(self) -> None:
        for size, digest in [*BACKGROUND_VIDEOS.values(), *LIVING_PACK_ASSETS.values()]:
            self.assertGreater(size, 0)
            self.assertRegex(digest, r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
