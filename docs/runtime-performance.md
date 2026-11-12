# Runtime performance: 0.1.231

This release reduces repeated host work and model bookkeeping requests while
preserving complete tool evidence and durable recovery boundaries. It does not
change the selected model, reasoning effort, or user authorization.

## Provider reuse

Daemon turns with identical provider settings share a provider, HTTP connection
pools, protocol negotiation, and a single in-flight capability lookup. The cache
holds at most 16 configurations and expires providers after five minutes.
Failed or incomplete metadata expires after 30 seconds. Endpoint, credentials,
model, protocol, and reasoning effort are all part of the cache identity.

Expiration applies when starting a new turn. An active turn keeps its provider
and negotiated route; a later turn can retry the preferred route after an earlier
fallback. No credentials are logged by the cache.

## Skills

Skill discovery caches parsed files and directory listings. Ordinary file edits
invalidate entries through metadata changes; a 30-second revalidation also
handles filesystems that preserve timestamps. Exact reads check only the matching
paths in precedence order. Workspace shadowing, plugin changes, enable/disable,
save/import, and dynamically available dependencies keep their existing behavior.

This is a host cache. Skill bodies are still supplied to the model only when
requested; caching them does not put every skill into every prompt. Cache eviction
never truncates a skill or the discovery result.

## Tool checkpoints

Before a sequential action or a bounded parallel group is polled, its admission
is durably saved. A snapshot may also include the preceding completed result.
Completed results are saved before awaiting another sibling or dispatching more
work. Cancellation and persistence failures cannot silently admit new actions.

Deterministic regression fixtures reduce checkpoint saves as follows, excluding
the separate interim assistant-message commit:

| Tool batch | Before | After |
| --- | ---: | ---: |
| 10 parallel calls | 21 | 11 |
| 3 sequential calls | 7 | 4 |
| 5 mixed calls | 11 | 7 |

History redaction, serialization, and SQLite persistence run in an awaited
blocking task. The runner still waits for durable storage. Full snapshots,
memory-generation guards, actual user-visible replies, and recovery evidence
are retained. Agent history saves own their record lock through persistence,
including if the caller is cancelled.
Daemon shutdown retains the instance lock until the runtime has drained blocking
writes, preventing a replacement process from overtaking unfinished persistence.

## Completion and plan review

When the turn owns an unfinished plan, one restricted completion-review response
can update verified plan progress and report finished, blocked, or continue.
The separate post-turn plan-reconciliation loop and acknowledgement inference
are removed. No model-produced update executes until the response ends cleanly
and contains exactly one valid completion decision.

The restricted executor preserves task identities and scope, rejects unrelated
actions and completed-task downgrades, and keeps graph dependency validation.
Timeouts, malformed replies, and unavailable review preserve the answer and
existing progress. Cancellation still interrupts review.

## Reference and validation

The design was informed by OpenAI Codex at commit
[`672e99f`](https://github.com/openai/codex/tree/672e99fed8da8e5efc3268c52cddc4fc97ffd078):

- [Skill host caching and single-flight loading](https://github.com/openai/codex/blob/672e99fed8da8e5efc3268c52cddc4fc97ffd078/codex-rs/ext/skills/src/host_service.rs).
- [Model metadata cache lifetime](https://github.com/openai/codex/blob/672e99fed8da8e5efc3268c52cddc4fc97ffd078/codex-rs/models-manager/src/manager.rs).
- [Session client reuse](https://github.com/openai/codex/blob/672e99fed8da8e5efc3268c52cddc4fc97ffd078/codex-rs/core/src/client.rs).
- [Asynchronous rollout persistence](https://github.com/openai/codex/blob/672e99fed8da8e5efc3268c52cddc4fc97ffd078/codex-rs/rollout/src/recorder.rs).

miniQ retains its durable SQLite checkpoint contract rather than copying Codex's
rollout storage format. Completion-review consolidation is a miniQ-specific
removal of duplicate work. Streaming tool dispatch, WebSocket transport, and
default background-agent scheduling are outside this release.

GitHub Actions tests the model, skill, agent, persistence, daemon, and skill-tool
contracts on Linux and Windows, then checks the workspace. The release workflow
also validates the frontend and builds/packages native targets. The call and
write counts above are structural regression assertions, not claims about a
measured percentage improvement in end-to-end latency or token usage.
