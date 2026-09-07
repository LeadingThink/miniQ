# Android Production Releases

Android uses an independent version and tag: the initial production release is
`versionName "0.1.17"`, `versionCode 17`, tag `android-v0.1.17`.
Do not change desktop npm, Cargo, Tauri or updater versions for an Android-only
release. Increment Android versionCode on every subsequent release; never reuse
a tag or an existing versionCode. The tag must match Gradle versionName.

## Signing

Use a dedicated production keystore, never the Android debug keystore. Retain
the keystore and passwords securely: subsequent upgrades must use the same key.
Configure these repository Actions secrets through the approved secure process:

- `ANDROID_KEYSTORE_BASE64`: base64 encoding of the dedicated keystore.
- `ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `ANDROID_KEY_ALIAS`: production key alias.
- `ANDROID_KEY_PASSWORD`: key password.

The workflow decodes the keystore into `RUNNER_TEMP` with mode 0600 and deletes
it in an always-run cleanup step. It does not log passwords or upload signing
material. Missing credentials stop both CI preparation and Gradle release tasks.
Debug builds remain usable without production credentials.

Existing Qiniu secrets (`QINIU_ACCESS_KEY`, `QINIU_SECRET_KEY`, `QINIU_BUCKET`)
and `RELEASES_TOKEN` are also required. The bucket must serve `oss.zaiwen.top`.

## Validate and Release

From `apps/desktop`:

```sh
npm ci
python3 scripts/android_release.py validate --tag android-v0.1.17
python3 scripts/android_release_test.py
npx vitest run src/components/MobileEntry.test.ts src/remoteCrypto.test.ts src/remotePayload.test.ts src/remoteBlob.test.ts src/hooks/useDaemonConnection.test.ts src/hooks/useDaemonConnection.integration.test.tsx
npm run build
npx cap sync android
```

For a local signed build, use JDK 21 and Android SDK platform 36/build-tools
36.0.0. Set `JAVA_HOME` and `ANDROID_HOME` to those installations. Securely load
`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and
`ANDROID_KEY_PASSWORD` into the build process environment from the retained
production signing material. Do not generate a replacement key or print these
values. Then, from `apps/desktop` after the frontend steps above:

```sh
(cd android && bash gradlew --no-daemon assembleRelease)
mkdir -p ../../dist-android
cp android/app/build/outputs/apk/release/app-release.apk ../../dist-android/miniQ_0.1.17_android.apk
python3 scripts/android_release.py verify --tag android-v0.1.17 \
  --apk ../../dist-android/miniQ_0.1.17_android.apk \
  --tools "$ANDROID_HOME/build-tools/36.0.0"
"$ANDROID_HOME/build-tools/36.0.0/zipalign" -c -P 16 4 ../../dist-android/miniQ_0.1.17_android.apk
```

These commands build and verify locally only; they do not publish anything.

After explicit release authorization, review and commit only intended changes,
push the source commit, then create and push `android-v0.1.17` on that commit.
Dispatch the existing workflow, not a manual release upload:

```sh
gh workflow run release.yml --repo LeadingThink/miniQ \
  -f platform=android -f tag=android-v0.1.17 -f draft=false
```

Omitting `platform` retains the existing desktop behavior. `windows_only` has no
effect on Android. Android requires `draft=false`; draft requests fail before
checkout or publication, so they cannot expose an APK or change the public manifest.

CI uses Node 22 and JDK 21, builds with `assembleRelease`, checks the APK with
`apksigner` and `aapt` (pinned production certificate, non-debug signing,
debuggable false, package and versions),
then retains the APK as an Actions artifact before publishing it to:

- `https://oss.zaiwen.top/releases/miniq/android/v0.1.17/miniQ_0.1.17_android.apk`
- `https://github.com/LeadingThink/miniQ-releases/releases/tag/android-v0.1.17`

The mirror uses the identical APK and `--latest=false`, so Android never becomes
the desktop's latest GitHub release. No desktop `latest.json` is written.

The publisher must successfully read `https://oss.zaiwen.top/releases/manifest.json`.
It deep-merges only `products.miniq.platforms.android`, preserving other products,
product versions, platforms and unknown Android fields. It sets `version`,
`releaseDate`, `status`, `url`, `sha256`, `fileSize`, `minAndroidVersion`, and
`installationNotes` (an array of Chinese installation instructions).
APK upload, storage size verification and downloaded SHA-256 verification precede
the metadata write. A changed remote manifest aborts publication before overwriting
metadata. Android CI releases are serialized; coordinate with external manifest
writers because object storage does not provide an atomic compare-and-swap here.
Never replace an unreadable remote manifest with an empty/default manifest.

Monitor CI to completion, then verify both downloads have the same SHA-256 and
size and that the public manifest describes the APK. Check that desktop updater
manifests and other products/platforms are unchanged. Installation over earlier
debug-signed APKs is not supported: uninstall first, which removes local app data.

The pinned public production certificate SHA-256 is
`05:D2:27:24:D2:AD:38:32:90:39:0B:C1:DB:FB:25:E5:39:40:DD:8F:E2:C4:5F:AB:C0:65:D2:F0:D6:00:22:0C`.
