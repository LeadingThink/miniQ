# miniQ system prompt

`system-prompt.md` is miniQ's complete, independently maintained base prompt.
It contains the behavioral instructions, miniQ identity, and actual runtime tool
bindings in one file. The daemon embeds that file directly, without runtime text
replacement, prompt-fragment assembly, or access to a reference repository.
Edit this file to change miniQ's base instructions.

The runtime environment, project instructions, host file links, goals, plans,
memory routing, authorized roots, skills, and side-conversation policy are
session context supplied by `src/turn_context.rs`. Main turns and child agents
use the same embedded base prompt.

## Attribution

The behavioral instructions were copied in full from Codex's `gpt-6.1-sol`
`model_messages.instructions_template`, with two identity changes: the opening
Codex/GPT-6 identity becomes miniQ's identity, and `As Codex,` becomes `As miniQ,`.
The following `<miniq_runtime_bindings>` section documents miniQ's tool APIs.

- Source: https://github.com/openai/codex/blob/23934d31b15b1127c83535f84854e5009f7cd51d/codex-rs/models-manager/models.json
- Source commit: `23934d31b15b1127c83535f84854e5009f7cd51d`
- Original full-template SHA-256: `e1bdd4f8f0df4b20f4a0ffc8a861ce819df45325d8cecdfb92e80379cf8d142e`
- Behavioral text SHA-256, restoring the original identity and ignoring trailing whitespace: `6df4f6b6b8d1ce39e103a724d36d77d712c5f8ed518ff7e43270554a3613954f`
- License: Apache-2.0; upstream attribution is in `LICENSE.codex` and `NOTICE.codex`.

Model-specific permissions, collaboration modes, and optional persistent-mode
messages from the Codex catalog are not part of the copied base template;
miniQ's runtime owns those capabilities and policies.

## Verification

From the repository root:

```powershell
node --test scripts/system-prompt.node-test.mjs
```

The test verifies the complete copied behavioral text, miniQ identity, runtime
bindings, and attribution using only files in this repository. When intentionally
editing the behavioral instructions, review the complete diff and update the
behavioral checksum in this document and its test.
