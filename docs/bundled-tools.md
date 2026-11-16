# Desktop tool availability

Desktop packages include the miniQ daemon sidecar but do not bundle ripgrep.
Shell commands, managed processes, terminals, and helper subprocesses inherit
the user's normal system `PATH`. If `rg` is installed there, read-only search
commands can continue to use it; miniQ does not download or install it.

The Windows desktop app runs inside WebView2. Android uses Android WebView, and
iOS uses WKWebView. None of these WebView layers depends on a bundled ripgrep
binary, so removing the sidecar does not change the frontend or mobile entry
points.

On systems without `rg` in `PATH`, commands that explicitly invoke `rg` are
unavailable. Other miniQ features and the remaining system tools such as
`grep`, `find`, and `findstr` are unaffected.

Run `npm run test:desktop-bundle` from `apps/desktop` to verify that the daemon
remains bundled and the ripgrep sidecar remains excluded. Run
`cargo test --locked -p miniq-local runtime_path::` from the repository root to
verify user PATH discovery.
