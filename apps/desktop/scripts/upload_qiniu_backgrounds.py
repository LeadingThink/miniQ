"""Mirror the pinned living-background assets to the Qiniu primary origin.

Each asset is downloaded from the source origin, verified against the pinned
size and sha256, uploaded, then read back from the public domain and verified
again so the desktop app never streams an unexpected file.

Two sets are mirrored:
- the original wallpaper loops under ``themes/backgrounds``;
- living pack-01 (video, poster and thumbnail per wallpaper), which Zaiwen
  serves from ``media/living/pack-01`` and miniQ reads from
  ``web/wallpapers/living/pack-01``.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
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

LIVING_PACK = "pack-01"
LIVING_SOURCE_PREFIX = f"media/living/{LIVING_PACK}"
LIVING_OBJECT_PREFIX = f"web/wallpapers/living/{LIVING_PACK}"

# file name -> (size in bytes, sha256)
LIVING_PACK_ASSETS: dict[str, tuple[int, str]] = {
    "w001-lighthouse-poster.jpg": (180171, "ea2b303ef8165af0b56705381ac67907904b9d334c338c121f84572363441033"),
    "w001-lighthouse-thumb.jpg": (66724, "912dc8ff931414884e591294f2692fce02f70c093035e3d737d9beae9a12cd77"),
    "w001-lighthouse.mp4": (2288056, "d25ac7d661e966e6dc16f2edf15a82b66142fabfeeb8d58e5f70fb9729a994bd"),
    "w002-sakura-river-poster.jpg": (305007, "3dd32512029528f769e9e3fa65c3027e5d6471805fb8b45cc7546e184f837c97"),
    "w002-sakura-river-thumb.jpg": (103122, "ca4dc3df2ee58c0b95dca63bbce565565c8b599360863c1985d6fe683fb0c819"),
    "w002-sakura-river.mp4": (3293936, "d1a9475752c339ea9a5cad3f1ba4b3bdffde3630923f34c67fb88e29a340be0f"),
    "w003-autumn-temple-poster.jpg": (246477, "2b488a94189430d7b408013af5790acf5bfd33c53c93a814fca925717973f8ff"),
    "w003-autumn-temple-thumb.jpg": (89715, "bf2a98025be8af8139aff19cdb848d7d03ce01384e311a40c5fff2fe97cf2564"),
    "w003-autumn-temple.mp4": (1901808, "5a6c3e3341bef1f295aff45fb595dc8a041cc155ced08f8528f323f24e3c4207"),
    "w004-snow-cabin-poster.jpg": (246935, "66eeeab6970451b61c4db1e87d18512487025d964b3747362efc11f58181af35"),
    "w004-snow-cabin-thumb.jpg": (82978, "76f120312c19a0853693fc5d9d598c41b71d8ce671d969d2c933eafde5950062"),
    "w004-snow-cabin.mp4": (2434444, "f0c3b5ef8b071ffee1ecfe6c1742c6500bd20be3a198311468131bbf159a6514"),
    "w005-summer-field-poster.jpg": (255891, "7886225b37b4e28987f90be1fac36b5725adcbb4acb4d2052c4c824b34ff8733"),
    "w005-summer-field-thumb.jpg": (89932, "ada2eeeb470228aba193f0e8471c854adf789f43a52b19a6478eff504e6097d3"),
    "w005-summer-field.mp4": (2282906, "3fda5b371ec4b8d80f3174c069e07f2b95f141a244f3ab29f7c1558bd9131374"),
    "w006-tokyo-alley-poster.jpg": (266113, "3a9fe6e8d5f31ff9f82d4a25603b53973d810e63bd7b1626aaa0fce61983fdf4"),
    "w006-tokyo-alley-thumb.jpg": (87254, "51f2c9fcf253452b5d962366201f56321d7b773628380574d2c2d4a94e7461af"),
    "w006-tokyo-alley.mp4": (1841123, "c058b58f88eed8d37fa51ef60b69e39cf1a2f8c5b4c265cb409dda8a688f2282"),
    "w007-city-window-poster.jpg": (150987, "05d82c1a3c759257e4ebf9f076bbe7a04ae0272831e4e2913574c67a74e88ec2"),
    "w007-city-window-thumb.jpg": (53136, "5729950b29665828407a012efcfaeaf02c45f11b843a7340eae6a4743da9bec6"),
    "w007-city-window.mp4": (1208984, "9b337e3e8147e51ee7700b810acec5638a4dd7ad72a755bf9d5ebd2e42acf398"),
    "w008-tram-dusk-poster.jpg": (220213, "88745fa31993684df886693214393b4d5255e5580fe7ba004f0203e35e43b22e"),
    "w008-tram-dusk-thumb.jpg": (79006, "f129534df9f7e1a04e9642e5ee6363c130783367ac1b4ccd547bd178b7ef97bb"),
    "w008-tram-dusk.mp4": (2192904, "905f19cc7709e256d75f94b3984dbe703db4b95261adb23b812f391af8102f69"),
    "w009-bookcafe-poster.jpg": (187280, "b0e538c33388c21f43d672512f0291354fee935abd68527b7d8fecb9370b80fa"),
    "w009-bookcafe-thumb.jpg": (66107, "0131a4db03cc4a2f373e3036360d42f1483212c1ea3c0ffa6fcd7e5dbfc9fd59"),
    "w009-bookcafe.mp4": (1877391, "b930e54f322b341c116d236d4d5c9285887f44f6dd1f8688e64ad43e251b9132"),
    "w010-fox-forest-poster.jpg": (152594, "f3c36482e8c368aa35a7cfa0621436d35f78e267715a5675551a7ba80748babe"),
    "w010-fox-forest-thumb.jpg": (59096, "79bf6a537427e196aa6e8b66b3389642dce1a0970c4cdea3c33410fa2575c942"),
    "w010-fox-forest.mp4": (1046597, "3e9d8ec0f4ae6509521097c0d8d926fb7efd0040fab75d74b479e9e750407c9c"),
    "w011-panda-bamboo-poster.jpg": (178412, "c453958101fe2c93af0bc0df00e1a6661e542f7f8d6cbe9704f72a45d254ae1d"),
    "w011-panda-bamboo-thumb.jpg": (62011, "8d5c1b05bc5551fd876bbcfb2f66e8d754865454b2c3063cb22c0ed9b1601b4d"),
    "w011-panda-bamboo.mp4": (1344357, "4cfcaa8e1ed8038a8eb98e2a8eb08cd8dba806e5d62f74bdddc9e7cdf8d920a7"),
    "w012-corgi-beach-poster.jpg": (169888, "2b16d5c1457dd65e5a88a072301df836f58a00774d6f49a243b915ea969d68a7"),
    "w012-corgi-beach-thumb.jpg": (66602, "acd77546264931daefca84bb8a07808e91acd5fdea59c25fd0d9c221f5f0b6e6"),
    "w012-corgi-beach.mp4": (2076148, "186a0f4aac96cc101e685fb032c0618b4400d7f1978242d86c60ab063154c3ba"),
    "w013-owl-library-poster.jpg": (130431, "45ed1b99b950315e79c90f11d9a990f574c73579c5aa09cc29bb75232864a0af"),
    "w013-owl-library-thumb.jpg": (52845, "1f520488bde504d7debc4250c14137507eda2de3b088c16017ba8cbfea3e7ed4"),
    "w013-owl-library.mp4": (953267, "02610cb7709d8d67ec3b0f4047a4ac5eb272f93d0e9c849fa2d7a7216e9d99db"),
    "w014-floating-island-poster.jpg": (210828, "be3eacf7aa364917ab43609b393e971596140a41a03d9cdad3386ed8f23601f9"),
    "w014-floating-island-thumb.jpg": (75994, "59b42dd99253d65fcc799844ad7207133fe48233b6e862efb8c338e1a1272ea7"),
    "w014-floating-island.mp4": (1396643, "2391d364afa3fbd268f1c0bb533f58ff2c760f8b69f48c935df5063f9136904f"),
    "w015-whale-sky-poster.jpg": (216269, "3f1e971de2b4770c4a22f743983d6db05bd20510b3c14794ce236d0c5c89e805"),
    "w015-whale-sky-thumb.jpg": (77557, "0561ff7987969bf9426bc8376fcff3e0471ce7c76684c765c8bf16f154178069"),
    "w015-whale-sky.mp4": (1737223, "55aed0a83a9b1ed45dfb8dac368f73d9e48c827eb558d6dd0dd0a58e6b37076a"),
    "w016-glow-mushroom-poster.jpg": (257878, "8a78db47c9682fdd3340a0c23c25d9c227ca90449117ebe2affc1ff5010873ba"),
    "w016-glow-mushroom-thumb.jpg": (84990, "132a58a350f5b84230c5839807e51e0ae131d624467f7bdf7312deba1dc164c5"),
    "w016-glow-mushroom.mp4": (2540076, "bdc34ee344b88169608b5a25792ffabf35f740dfa91ebbb15c07880be801beda"),
    "w017-lantern-river-poster.jpg": (224075, "e36cf83569ceb2f6b94c71403464e17f3fe4d3b458a9453b197ada9246a2e5e9"),
    "w017-lantern-river-thumb.jpg": (77237, "ef30c566c3889b92a47afa0d65b745dc48c3d611ab05d50619b70a935f935ded"),
    "w017-lantern-river.mp4": (2782754, "aae33c9c136e51816120e7832af5caf6702d8f7e3b35b365624d9b398ccddfa0"),
    "w018-aurora-lake-poster.jpg": (183217, "aff105121191698aa0bfa65dadc0aeb7e6c5acc288f37968259d34445bf75bf6"),
    "w018-aurora-lake-thumb.jpg": (56524, "ed656256fb2fae0a008affa9bdc125a901c4713edffdff926efb3df005d59782"),
    "w018-aurora-lake.mp4": (1515947, "09f9edccafecc183d886baefcb8b02dd50887d812666b270a84b30a8befdbc8b"),
    "w019-milkyway-hill-poster.jpg": (226833, "0ebadbf1b279415a6c55a3476240281efb80e799683ca5d77a6855e13f3b0924"),
    "w019-milkyway-hill-thumb.jpg": (68783, "54555fbda1a831cb36615a692e75dee09f949381bfc66a8fde52fa0c67029d1c"),
    "w019-milkyway-hill.mp4": (2802815, "0c2852bef2324f2903e9fa989629f084091803564f3880de48af28ce7a6bf7b7"),
    "w020-planet-rings-poster.jpg": (185097, "11959a104926a2bc1a654e8747f87c3548e1e76cae609e837e8283d6de3b75b2"),
    "w020-planet-rings-thumb.jpg": (63359, "828d56ef8df9da830ad10434a5cf038801beffdc9ac829e53b60d40e46faa405"),
    "w020-planet-rings.mp4": (1361672, "95f5328b12b1add23615f0b756ea3cdcac883f171fd90d4c5d6c17fb39dc31a5"),
}


@dataclass(frozen=True)
class Asset:
    name: str
    source_path: str
    object_key: str
    size: int
    digest: str


def object_key(background_id: str) -> str:
    return f"{OBJECT_PREFIX}/{background_id}.mp4"


def living_object_key(file_name: str) -> str:
    return f"{LIVING_OBJECT_PREFIX}/{file_name}"


def assets() -> list[Asset]:
    items = [
        Asset(background_id, object_key(background_id), object_key(background_id), size, digest)
        for background_id, (size, digest) in BACKGROUND_VIDEOS.items()
    ]
    items.extend(
        Asset(name, f"{LIVING_SOURCE_PREFIX}/{name}", living_object_key(name), size, digest)
        for name, (size, digest) in LIVING_PACK_ASSETS.items()
    )
    return items


def verify_asset(asset: Asset, data: bytes) -> None:
    if len(data) != asset.size:
        raise ValueError(f"{asset.name}: expected {asset.size} bytes, got {len(data)}")
    actual = hashlib.sha256(data).hexdigest()
    if actual != asset.digest:
        raise ValueError(f"{asset.name}: sha256 mismatch ({actual})")


def verify_bytes(background_id: str, data: bytes) -> None:
    size, digest = BACKGROUND_VIDEOS[background_id]
    verify_asset(Asset(background_id, "", "", size, digest), data)


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "miniq-background-publisher"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def download_sources(source_origin: str, target: Path) -> list[UploadItem]:
    items = []
    for index, asset in enumerate(assets()):
        data = fetch(f"{source_origin}/{asset.source_path}")
        verify_asset(asset, data)
        path = target / f"{index:03d}-{Path(asset.object_key).name}"
        path.write_bytes(data)
        items.append(UploadItem(path, asset.object_key))
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
    for asset in assets():
        verify_asset(asset, fetch(f"{domain}/{asset.object_key}"))
        print(f"verified {domain}/{asset.object_key}")


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
