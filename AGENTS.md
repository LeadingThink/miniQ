# miniQ Agent Instructions

## Engineering Rules

1. Follow sound software engineering practices. Keep modules cohesive, coupling low, and responsibilities clear. Source files should normally stay under 500 lines and functions under 100 lines. Documentation and generated files are exempt. Do not split code mechanically just to satisfy line limits.

2. Before running Python, tests, formatters, or type checks, determine the correct working directory. If `backend/pyproject.toml` or `backend/uv.lock` exists, run from `backend`; otherwise run from the current project directory.

3. If the execution directory contains `uv.lock`, or the project explicitly uses uv, run Python through `uv run` or another uv command. Do not invoke `python`, `pytest`, or `pip` directly.

4. Prefer shared abstractions for genuinely repeated behavior. Do not add abstraction layers that do not remove meaningful duplication or complexity.

5. Avoid speculative fallback, compatibility, and backup branches. Solve the root problem with the simplest complete design.

6. Treat the new design as authoritative. Do not keep old and new implementations in parallel. Update every caller and remove replaced code.

7. In AI Agent code, keep JSON Schema, Pydantic models, tool parameters, and runtime validation aligned for field types, required fields, defaults, enums, and numeric constraints. Prefer generating JSON Schema from Pydantic models.

8. Do not truncate strings, lists, or dictionaries as a convenience. For large data, use pagination, batching, or streaming without losing data.

9. After changing behavior, remove replaced branches, obsolete helpers, and tests that only cover the old design. Add or update tests for the new behavior. Never delete valid tests merely to make a test run pass.

10. Most Stitch `screen instance` objects are hidden. An instance with `"hidden": true` is not a current visible page unless the task explicitly says otherwise.

11. After code changes, run relevant tests, formatting checks, and type checks. Inspect the final diff for duplicate logic, obsolete code, debug code, generated artifacts, and unrelated changes.

12. Do not run the entire test suite by default. Run it only when the change risk or release validation requires it.

## Git Safety

- Preserve user changes and unrelated dirty-worktree files. Never revert them unless explicitly requested.
- Do not use destructive Git commands such as `git reset --hard` or `git checkout --` without explicit approval.
- A request to commit or push code is not a request to publish a new application version.

## Release Authorization

Only start a release when the user explicitly asks to publish or release a new version. Do not infer release authorization from requests such as "finish the feature", "commit", "push", "build", or "test automatic updates".

Without an explicit release request, do not:

- change application version numbers;
- create, move, or push a version tag;
- trigger `.github/workflows/release.yml`;
- create or modify a GitHub Release;
- upload installers, signatures, or updater metadata.

When release authorization is explicit, use the existing GitHub Actions workflow. Do not bypass it with a manual `gh release create` flow.

## Windows Release Workflow

The current release pipeline publishes a signed Windows x64 NSIS installer and Tauri updater metadata. Source code and tags live in `LeadingThink/miniQ`; release assets live in `LeadingThink/miniQ-releases`.

1. Determine the requested semantic version. If no version is specified, use the next appropriate version and state it before making release changes. Never reuse or move an existing release tag.

2. Confirm that the intended release changes are complete. Review the worktree and exclude unrelated user changes from the release commit.

3. Update every project version consistently:

   - `Cargo.toml` under `[workspace.package]`;
   - `apps/desktop/package.json`;
   - the root package entries in `apps/desktop/package-lock.json`;
   - `apps/desktop/src-tauri/Cargo.toml`;
   - `apps/desktop/src-tauri/tauri.conf.json`;
   - the workspace `Cargo.lock`;
   - `apps/desktop/src-tauri/Cargo.lock`.

   From `apps/desktop`, `npm version <version> --no-git-tag-version` may be used to update `package.json` and `package-lock.json` together.

4. Validate the release from the correct directories. At minimum run:

   ```powershell
   cd apps/desktop
   npm run release:check-version -- v<version>
   npm test
   npm run build

   cd ../..
   cargo fmt --all -- --check
   cargo test -p miniq-daemon
   cargo check --workspace
   cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
   git diff --check
   ```

   Broaden tests when the release changes shared or high-risk behavior.

5. Inspect the final diff and status. Commit the intended release contents, push the release commit to `origin/main`, create tag `v<version>` on that exact commit, and push the tag.

6. Trigger the existing workflow:

   ```powershell
   gh workflow run release.yml `
     --repo LeadingThink/miniQ `
     -f tag=v<version> `
     -f draft=false
   ```

7. Monitor the workflow until it reaches a terminal state. Do not report success while it is still running.

8. On success, verify the release in `LeadingThink/miniQ-releases` contains all required assets:

   - `miniQ_<version>_x64-setup.exe`;
   - `miniQ_<version>_x64-setup.exe.sig`;
   - `latest.json`.

9. Verify `latest.json` points to browser download URLs for the same release and that the release is published rather than left as a draft. Report the source commit, tag, workflow URL, release URL, and verification result.

Never print or expose `RELEASES_TOKEN`, `TAURI_SIGNING_PRIVATE_KEY`, or `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
