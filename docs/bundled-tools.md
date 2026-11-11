# Bundled desktop tools

The Windows, macOS (Apple Silicon and Intel), and Linux desktop packages include
ripgrep 15.1.0. Desktop-launched daemons prepend the directory containing the
bundled `rg` executable to their command environment's PATH. Shell commands,
managed processes, terminals, and helper subprocesses inherit it. No changes to
the user's system PATH or PowerShell profile are needed. The installed bundled
version takes precedence over a system ripgrep.

`npm run prepare:ripgrep`, from `apps/desktop`, downloads the upstream release
archive and verifies its pinned SHA-256 before extracting the executable and
license files. Linux uses the static musl release to avoid adding a glibc
requirement. Preparation uses Windows PowerShell with the system proxy settings
on Windows, and `curl` on macOS and Linux; extraction uses the system `tar`.
Tauri includes `rg` as an external binary alongside the desktop
executable; the bundle also includes `COPYING`, `LICENSE-MIT`, and `UNLICENSE`
under `licenses/ripgrep`. The application does not download tools at runtime.

Both Tauri development and production build hooks prepare ripgrep automatically.
Cross builds set `MINIQ_DAEMON_TARGET` to the Rust target triple; the GitHub Actions
build and release workflows already do so. Prepared binaries and license files
are generated artifacts and are ignored by Git. To update ripgrep, update its
version and all archive hashes in `apps/desktop/scripts/prepare-ripgrep.mjs`.

Run `npm run test:ripgrep` from `apps/desktop` and
`cargo test --locked -p miniq-local runtime_path::` from the repository root.
The daemon lifecycle workflow runs preparation and runtime PATH tests on Windows,
macOS, and Linux. Standalone terminal archives retain their existing contents;
this bundling applies to the desktop packages.
