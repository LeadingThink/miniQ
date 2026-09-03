# Desktop updates

miniQ uses the Tauri 2 updater with signed artifacts hosted on Qiniu at
`https://oss.zaiwen.top/releases/miniq/`. The public `LeadingThink/miniQ-releases`
repository remains a mirror and emergency fallback. Source code can remain
private while installed clients fetch releases without embedded credentials.

## Client behavior

- Packaged builds check for updates ten seconds after startup and every three hours.
- Development builds never contact the update endpoint.
- An available version appears in the sidebar.
- Clicking the update downloads and verifies the complete package before stopping the daemon.
- The authenticated `daemon.shutdown` RPC cancels active turns and closes the local server.
- The desktop waits for the daemon port to close, installs the package, and relaunches.

The first updater-enabled build must still be installed manually. Every later
version can update from the signed release feed.

The initial release may be published from a locally signed build by uploading
the NSIS installer, its `.exe.sig` file, and a matching `latest.json`. Later
releases should use the workflow below so metadata is generated automatically.

## Signing secrets

The private source repository must define:

- `TAURI_SIGNING_PRIVATE_KEY`
- `RELEASES_TOKEN`

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is only needed when the configured private
key was generated with a password.

`RELEASES_TOKEN` must be a fine-grained token limited to the
`LeadingThink/miniQ-releases` repository with read/write access to Contents.
The repository also requires `QINIU_ACCESS_KEY`, `QINIU_SECRET_KEY`, and
`QINIU_BUCKET` secrets. Limit that Qiniu key to release-object upload and CDN
refresh permissions for the production bucket.
Do not use a broad personal access token. The updater public key is committed in
`apps/desktop/src-tauri/tauri.conf.json`; the private key must never be committed.

Formal macOS releases also require an active Apple Developer Program team and:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application certificate (`.p12`)
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`: an app-specific password, not the Apple ID password
- `APPLE_TEAM_ID`

The release workflow fails before building macOS when any Apple value is missing.
This prevents an unsigned, unnotarized DMG from being presented as a production
download. The same Apple Developer Program team can later sign the 在问 iOS App;
it does not require a second program membership.

## Publishing

1. Update the version in the root workspace, desktop Cargo manifest,
   `apps/desktop/package.json`, and `apps/desktop/src-tauri/tauri.conf.json`.
2. Run `npm run release:check-version -- vX.Y.Z` in `apps/desktop`.
3. Commit, create and push the `vX.Y.Z` source tag.
4. Run the `Release Desktop Update` workflow with that tag.

The workflow builds matching daemon sidecars and signed updater artifacts for
Windows x64, macOS Apple Silicon, macOS Intel, and Linux x64. It publishes NSIS,
DMG, AppImage, and deb installers, then creates one `latest.json` containing all
four updater targets. Versioned assets are uploaded to Qiniu first, followed by
the stable update manifest and a CDN refresh; GitHub Releases receives the same
files plus its own GitHub-addressed `latest.json` as a functional fallback. A
release is published only after every target succeeds.
The workflow also updates `https://miniq.zaiwenai.com/latest.json` in the legacy
`miniq-zaiwenai` bucket so already-installed clients continue receiving updates.

Tauri update signatures protect package integrity. Windows Authenticode signing
is a separate requirement and should be added before broad public distribution
to reduce SmartScreen warnings.
