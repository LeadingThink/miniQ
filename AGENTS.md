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

The current release pipeline publishes signed desktop installers and Tauri updater metadata. Source code and tags live in `LeadingThink/miniQ`; Qiniu is the primary release origin and `LeadingThink/miniQ-releases` is the public mirror.

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

10. Verify the same assets exist under `https://oss.zaiwen.top/releases/miniq/v<version>/`, and that both `releases/miniq/latest.json` and the legacy root `latest.json` return the new version. Qiniu is the primary endpoint; GitHub is the fallback.

Never print or expose `RELEASES_TOKEN`, `TAURI_SIGNING_PRIVATE_KEY`, or `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## iOS TestFlight And App Store Workflow

The iOS app uses bundle identifier `com.leadingthink.miniq`. GitHub Actions builds on a macOS runner, signs the archive, exports the IPA, and uploads it to App Store Connect through `.github/workflows/ios-testflight.yml`. A TestFlight upload does not create a Git tag, GitHub Release, desktop update, or App Store review submission.

### Authorization And Secret Safety

- Only upload a new TestFlight build when the user explicitly asks to build or upload an iOS/TestFlight version.
- Only add an App Store version for review or submit it to Apple when the user explicitly asks for that exact action. Uploading to TestFlight is not authorization to submit an App Store review.
- Never print, copy into tracked files, or expose the values of `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD`, `IOS_APP_PROFILE_BASE64`, `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, or `ASC_PRIVATE_KEY_BASE64`.
- Keep certificates, `.p12`, `.p8`, `.mobileprovision`, passwords, screenshots, and local App Store preparation files out of Git. The repository-local `苹果注册/` directory is ignored for this purpose.
- Do not commit generated Xcode archives, IPA files, signing keychains, or downloaded GitHub Actions artifacts.

### Version And Build Number Rules

- `marketing_version` is the App Store version visible to users, such as `1.0`.
- `build_number` must be a positive integer greater than every build already uploaded for that marketing version.
- Before the first App Store version is approved, keep `marketing_version` at `1.0` and upload fixes as build `2`, `3`, and so on. Do not create `1.1` merely to replace an unapproved build.
- The workflow passes `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` to Xcode. A TestFlight-only build does not require changing the desktop semantic version or the checked-in Xcode defaults.
- Never reuse an App Store build number, even when an earlier workflow failed after Apple accepted the upload.

### Prepare And Validate

1. Fetch the remote and inspect incoming commits, current status, and untracked files. Preserve all user files and unrelated changes.

   ```powershell
   git fetch origin --prune
   git status --short --branch
   git log --oneline HEAD..origin/main
   ```

2. When the tracked worktree has no conflicting local changes, update `main` without creating an accidental merge commit:

   ```powershell
   git pull --ff-only origin main
   ```

3. Confirm the intended source commit and determine the next unused build number from App Store Connect or previous successful workflow runs.

4. From `apps/desktop`, run the same portable checks used by the workflow:

   ```powershell
   node --test scripts/ios_testflight.node-test.mjs
   npx vitest run src/components/MobileEntry.test.ts src/remoteCrypto.test.ts src/remotePayload.test.ts src/remoteBlob.test.ts src/hooks/useDaemonConnection.test.ts src/hooks/useDaemonConnection.integration.test.tsx
   npm run build
   ```

5. Run `git diff --check` from the repository root and inspect the final status. The macOS-only Capacitor sync, Xcode archive, signing, and IPA export remain the responsibility of GitHub Actions.

### Upload To TestFlight

1. Trigger the workflow against the intended `main` commit:

   ```powershell
   gh workflow run ios-testflight.yml `
     --repo LeadingThink/miniQ `
     --ref main `
     -f marketing_version=<version> `
     -f build_number=<build>
   ```

2. Record the workflow URL and verify its `headSha` matches the intended source commit.

3. Monitor the workflow until it reaches a terminal state. Do not report success while it is queued or running. A successful run must include successful completion of:

   - release input, source, and Secret validation;
   - mobile tests and frontend build;
   - distribution certificate and provisioning profile validation;
   - signed Xcode archive and IPA export;
   - `Upload build to App Store Connect`;
   - signing-material cleanup.

4. Verify the run produced the `miniq-ios-<version>-<build>-<attempt>` IPA/dSYM artifact and the corresponding log artifact. Artifacts are diagnostic outputs, not a public application release.

5. GitHub Actions success means Apple accepted the upload. App Store Connect may still show `Processing` for several minutes. Wait until the build appears under `TestFlight -> iOS 构建版本` and no export-compliance action remains.

### TestFlight And Store Preparation

1. In TestFlight, select the newest processed build for the internal test group. External testing additionally requires Beta App Review.

2. Test the exact candidate build on supported iPhone and iPad devices. Verify startup, authentication, chat, image/file preview, remote connection, keyboard behavior, rotation, zoom, and privacy-sensitive flows.

3. Use original device screenshots without chat-app compression, device frames, misleading edits, API keys, account data, or private conversation content.

4. iPad 8 screenshots are `2160 x 1620` in landscape or `1620 x 2160` in portrait, which App Store Connect does not accept in the current 13-inch slot. Preserve the originals and resize without cropping to:

   - landscape: `2752 x 2064`;
   - portrait: `2064 x 2752`.

   Upload these to the `iPad 13 英寸显示屏` screenshot group. Verify every generated file's pixel dimensions before upload.

5. Use these public metadata URLs:

   - privacy policy: `https://chat.zaiwenai.com/miniq/privacy`;
   - support: `https://chat.zaiwenai.com/miniq/support`.

6. Complete the App Store version metadata, screenshots, description, keywords, category, age rating, copyright, App Privacy questionnaire, review contact, export-compliance answers, and review login credentials when login is required. Never place real customer credentials in review notes.

### Select And Submit The Candidate

1. In `App Store Connect -> miniQ -> 分发 -> iOS App 版本 <version>`, scroll to `构建版本` and select the newest tested build. Remove an older selected build first when necessary.

2. Save the version and confirm the selected candidate is `<marketing_version> (<build_number>)`.

3. Use `添加以供审核` to run App Store Connect's completeness validation. Resolve every highlighted missing field. This adds the version to the review submission but does not itself send the submission to Apple.

4. Open `App 审核`, recheck the build number and all listed items, and only then use `提交以供审核` when the user has explicitly authorized formal submission.

5. After submission, report the source commit, marketing version, build number, workflow URL, upload result, and current App Store Connect status. Do not claim approval or publication while the version remains waiting for review, in review, or pending developer release.
