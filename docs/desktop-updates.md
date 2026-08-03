# Desktop updates

miniQ uses the Tauri 2 updater with signed artifacts hosted in the public
`LeadingThink/miniQ-releases` repository. Source code can remain private while
installed clients fetch releases without embedding GitHub credentials.

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
Do not use a broad personal access token. The updater public key is committed in
`apps/desktop/src-tauri/tauri.conf.json`; the private key must never be committed.

## Publishing

1. Update the version in the root workspace, desktop Cargo manifest,
   `apps/desktop/package.json`, and `apps/desktop/src-tauri/tauri.conf.json`.
2. Run `npm run release:check-version -- vX.Y.Z` in `apps/desktop`.
3. Commit, create and push the `vX.Y.Z` source tag.
4. Run the `Release Desktop Update` workflow with that tag.

The workflow builds the matching daemon sidecar, creates signed NSIS updater
artifacts, and publishes the installer, signature, and `latest.json` to the
public release repository.

Tauri update signatures protect package integrity. Windows Authenticode signing
is a separate requirement and should be added before broad public distribution
to reduce SmartScreen warnings.
