import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from upload_qiniu_release import UploadItem, main, publish, release_upload_plan


class UploadPlanTest(unittest.TestCase):
    def test_terminal_assets_exist_before_stable_installers_and_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("latest.json", "terminal.json", "install.sh", "install.ps1", "terminal.tar.gz"):
                (root / name).write_text("fixture", encoding="utf-8")
            keys = [item.object_key for item in release_upload_plan(root, "v1.2.3")]
            self.assertEqual(keys[-5:], [
                "releases/miniq/install.sh", "releases/miniq/install.ps1",
                "releases/miniq/terminal.json", "releases/miniq/latest.json", "latest.json",
            ])
            self.assertLess(keys.index("releases/miniq/v1.2.3/terminal.tar.gz"), keys.index("releases/miniq/terminal.json"))

    def test_terminal_manifest_requires_both_installers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("latest.json", "terminal.json", "install.sh"):
                (root / name).write_text("fixture", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "install.ps1"):
                release_upload_plan(root, "v1.2.3")

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

    def test_draft_plan_only_contains_versioned_release_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("latest.json", "terminal.json", "install.sh", "install.ps1", "latest.github.json"):
                (root / name).write_text("fixture", encoding="utf-8")

            keys = [item.object_key for item in release_upload_plan(root, "v1.2.3", "draft")]

            self.assertEqual(keys, [
                "releases/miniq/v1.2.3/install.ps1",
                "releases/miniq/v1.2.3/install.sh",
                "releases/miniq/v1.2.3/latest.json",
                "releases/miniq/v1.2.3/terminal.json",
            ])

    def test_latest_manifest_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "latest.json"):
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

    def test_draft_upload_skips_stable_manifest_and_cdn_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "latest.json").write_text('{"version":"0.1.17"}', encoding="utf-8")
            writes = []

            with mock.patch.multiple("upload_qiniu_release", publish=mock.DEFAULT,
                                     required_env=mock.DEFAULT, read_manifest=mock.DEFAULT,
                                     refresh_manifests=mock.DEFAULT) as mocks:
                mocks["required_env"].side_effect = lambda name: (
                    name if name in {
                        "QINIU_ACCESS_KEY", "QINIU_SECRET_KEY", "QINIU_BUCKET", "QINIU_DOMAIN",
                    } else self.fail(f"draft unexpectedly requires {name}")
                )
                mocks["publish"].side_effect = lambda items, *_: writes.append(
                    [item.object_key for item in items]
                )
                with mock.patch("sys.argv", [
                    "publisher", "--input", directory, "--tag", "v0.1.17", "--mode", "draft",
                ]):
                    self.assertEqual(main(), 0)

                self.assertEqual(writes, [["releases/miniq/v0.1.17/latest.json"]])
                mocks["read_manifest"].assert_not_called()
                mocks["refresh_manifests"].assert_not_called()


class UploadTransportTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.source = Path(directory.name) / "installer.bin"
        self.source.write_bytes(b"release artifact")
        self.item = UploadItem(self.source, "releases/miniq/v1.2.3/installer.bin")
        self.response = SimpleNamespace(status_code=200, exception=None)
        self.stat = mock.Mock(return_value=(
            {"fsize": self.source.stat().st_size, "hash": "uploaded-hash"}, self.response,
        ))
        self.regions = [object()]
        self.provider = mock.Mock(return_value=self.regions)
        self.config = SimpleNamespace(
            set_default=mock.Mock(),
            get_default=mock.Mock(side_effect={
                "default_query_region_host": "https://uc.example.test",
                "default_query_region_backup_hosts": ["backup.example.test"],
            }.__getitem__),
        )
        self.sdk = SimpleNamespace(
            Auth=mock.Mock(return_value=SimpleNamespace(upload_token=mock.Mock(return_value="private-token"))),
            BucketManager=mock.Mock(return_value=SimpleNamespace(stat=self.stat)),
            Region=mock.Mock(), config=self.config,
            put_file_v2=mock.Mock(return_value=({"hash": "uploaded-hash"}, self.response)),
        )
        modules = {
            "qiniu": self.sdk,
            "qiniu.http": SimpleNamespace(),
            "qiniu.http.endpoint": SimpleNamespace(Endpoint=SimpleNamespace(from_host=lambda host: host)),
            "qiniu.http.regions_provider": SimpleNamespace(get_default_regions_provider=self.provider),
        }
        patcher = mock.patch.dict("sys.modules", modules)
        patcher.start()
        self.addCleanup(patcher.stop)
        printer = mock.patch("builtins.print")
        self.print = printer.start()
        self.addCleanup(printer.stop)

    def test_region_discovery_stays_isolated_for_each_bucket(self):
        other_regions = [object()]
        self.provider.side_effect = [self.regions, other_regions]
        publish([self.item], "primary", "access", "secret")
        publish([self.item], "legacy", "access", "secret")

        self.assertEqual([call.kwargs["bucket_name"] for call in self.provider.call_args_list],
                         ["primary", "legacy"])
        self.assertEqual([call.kwargs["regions"] for call in self.sdk.put_file_v2.call_args_list],
                         [self.regions, other_regions])
        self.assertEqual([call.kwargs["regions"] for call in self.sdk.BucketManager.call_args_list],
                         [self.regions, other_regions])
        self.assertEqual(self.provider.call_args.kwargs["query_endpoints_provider"],
                         ["https://uc.example.test", "backup.example.test"])
        self.assertEqual(self.config.set_default.call_args.kwargs["connection_timeout"], 120)
        self.assertEqual(self.sdk.Region.call_args.kwargs["scheme"], "https")
        self.assertEqual(self.sdk.put_file_v2.call_args.kwargs["part_size"], 1024 * 1024)
        self.assertEqual(self.sdk.BucketManager.call_args.kwargs["preferred_scheme"], "https")

    def test_timeout_reports_exception_types_without_credentials(self):
        error = ConnectionError("private-token access secret bucket")
        error.__cause__ = TimeoutError("private-token access secret bucket")
        self.sdk.put_file_v2.return_value = (None, SimpleNamespace(status_code=-1, exception=error))

        with self.assertRaisesRegex(RuntimeError, "ConnectionError -> TimeoutError") as raised:
            publish([self.item], "bucket", "access", "secret")

        self.assertNotIn("private-token", str(raised.exception))
        self.assertNotIn("secret", str(raised.exception))
        self.assertNotIn("access", str(raised.exception))
        self.stat.assert_not_called()

    def test_region_discovery_exception_hides_credential_bearing_context(self):
        self.provider.side_effect = ValueError("private-token access secret bucket")

        with self.assertRaisesRegex(RuntimeError, "region discovery failed.*ValueError") as raised:
            publish([self.item], "bucket", "access", "secret")

        self.assertNotIn("private-token", str(raised.exception))
        self.assertNotIn("secret", str(raised.exception))
        self.assertNotIn("access", str(raised.exception))
        self.assertTrue(raised.exception.__suppress_context__)
        self.sdk.put_file_v2.assert_not_called()

    def test_wrong_remote_size_or_hash_stops_before_the_next_object(self):
        for field, invalid in (("fsize", 0), ("hash", "corrupted-hash")):
            with self.subTest(field=field):
                metadata = {"fsize": self.source.stat().st_size, "hash": "uploaded-hash", field: invalid}
                self.stat.return_value = (metadata, self.response)
                self.sdk.put_file_v2.reset_mock()
                with self.assertRaisesRegex(RuntimeError, "verification failed"):
                    publish([self.item, self.item], "bucket", "access", "secret")
                self.sdk.put_file_v2.assert_called_once()

    def test_progress_reports_each_sixteen_mib_and_completion(self):
        mib = 1024 * 1024

        def upload(*args, **kwargs):
            for uploaded in range(mib, 34 * mib + 1, mib):
                kwargs["progress_handler"](uploaded, 34 * mib)
            return {"hash": "uploaded-hash"}, self.response

        self.sdk.put_file_v2.side_effect = upload
        publish([self.item], "bucket", "access", "secret")

        progress = [call for call in self.print.call_args_list if ": " in call.args[0]]
        self.assertEqual([call.args[0].split(": ")[-1] for call in progress], [
            f"{16 * mib}/{34 * mib} bytes", f"{32 * mib}/{34 * mib} bytes",
            f"{34 * mib}/{34 * mib} bytes",
        ])
        self.assertTrue(all(call.kwargs["flush"] for call in self.print.call_args_list))


if __name__ == "__main__":
    unittest.main()
