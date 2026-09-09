# Question interaction release 0.1.22

## Scope and cause

The question body was rendered as plain text. Markdown lists, escaped filenames,
links and character references therefore appeared as source text. The reported
repeated draft labels were already present in one model-provided `ask_user`
prompt; they were not duplicated by the UI. That call provided no structured
options. Historical content is preserved without guessing choices or deleting
phrases with regular expressions.

## Delivered changes

- Reuse the existing Markdown renderer, including workspace-scoped file links.
- Present structured choices as vertical native radio buttons or checkboxes.
- Require explicit confirmation and accept multiline supplemental answers.
- Preserve answers after failed delivery, show the error inline and allow retry.
- Prevent duplicate submissions while waiting for acknowledgement and after success.
- Keep Chinese IME composition separate from submission and retain the existing
  automatic-continuation deadline.
- Keep all prompt content accessible in a bounded scroll region on small screens.
- Tell models to submit one final question, distinct string options, and no
  repeated draft alternatives. This is guidance, not a guarantee about model output.
- Include the latest main-branch settings save and dismissal fixes.

The prior product-roadmap documents contain separate unfinished projects. This
release does not mark those projects complete or claim to rewrite historical
questions.

## Verification

- `npm test`: 498 frontend tests, 6 release-manifest tests and 26 publisher tests.
- `npm run build`: TypeScript check and production build passed.
- `cargo test -p miniq-daemon`: 154 unit/integration tests passed.
- `cargo check --workspace` and `cargo fmt --all -- --check` passed.
- Tauri compilation passed with packaging-only sidecar lookup disabled for the
  source check. The release workflow builds and bundles the matching real daemon.
- Desktop, 390px and 320px browser checks covered wrapping, single/multiple choice,
  free answers, multiline paths, failed delivery and resubmission. These used an
  isolated fixture, not a production question or a live model request.
- `npm run release:check-version -- v0.1.22` and `git diff --check` passed.

The production build retains existing large Monaco/PPTX chunk warnings; they are
not failures and are not claimed as resolved by this interaction change.

Development preview: run the desktop Vite server and open
`/question-preview.html`. The fixture uses no daemon, API key or live session.

## Publication contract

Publish the new immutable source tag through `.github/workflows/release.yml`.
Verify the Qiniu and GitHub installers, signatures, updater manifests and shared
download-page manifest before reporting publication as complete. Web deployment
must retain prior hashed assets. Do not interrupt active desktop turns or child
agents to install the new application.
