# Model retry behavior

Temporary provider failures (including overload, connection/body decode failures,
and interrupted streams) retry the current model request, not completed tools.
Main turns, child agents and context compression share the same retry controller.
The default budget is 10 retries in addition to the original request. Provider
request duration no longer consumes a separate five-minute retry window.

Backoff starts at one second, doubles up to 32 seconds, and adds jitter. A
server's Retry-After is a minimum. Hints over the existing 120-second automatic
wait limit stop with an explicit explanation; miniQ never sends an early retry.
Cancellation interrupts waiting and in-flight model requests. Permanent errors
such as authentication, invalid input and billing failures are not retried.
Anthropic's explicit `stop_reason=refusal` is also a permanent provider refusal,
not an empty completion. It is recorded as a failed call with its stop reason
and usage instead of being retried ten times and recorded as successful.

Context compression serializes visible conversation fields only: roles, text,
attachment references, tool calls and their results. Native replay envelopes
(including private thinking, encrypted content and signatures) remain intact in
normal task history but are not exposed as transcript text to a summarizer.
The summary instruction treats history as data and forbids continuing its task.
Requests with no available tools explicitly set `tool_choice: "none"` for Chat
Completions/Responses and `tool_choice: {"type":"none"}` for Anthropic Messages.
Normal task requests still advertise and use their complete tool set.

If a summarizer nevertheless requests a tool, miniQ discards that attempt,
adds a text-only correction once, and retries within the existing budget. It
never executes or replays the requested tool. Partial summaries from failed or
unterminated streams are not installed as conversation checkpoints.

The request and response events carry the active retry count. The desktop and
mobile web UI retain this count while the request runs and label context
compression distinctly. The next successful model step clears the retry count.
An exhausted budget reports the actual retry count, limit, stop reason and last
provider error. Scheduled retries are recorded with session/child scope in local
audit records and logs, without prompts, tool payloads or credentials.

On 2026-09-07, the installed daemon's retained session events established that a
reported overload failure had retried three times during context compression.
Each request took roughly 95 seconds, so the former wall-clock budget prevented
the fourth retry. The final error did not communicate that reason. Regression
tests now simulate these slow requests through the tenth retry using virtual time.

Interrupted/failed turns preserve confirmed tool results through the session
checkpoint mechanism. Continuing remains controlled by the latest user request;
operations with uncertain side effects must be inspected before replay.

On 2026-09-13, retained Claude diagnostics showed successful task tool calls
followed by repeated compaction refusals with zero output tokens. Gemini
compaction diagnostics showed `finish_reason=tool_calls`. A live OneAPI check
using a retained 52-message history batch succeeded with the revised request for
both `claude-opus-5` (5,528 reported output tokens, `end_turn`) and
`gemini-3.8-flash` (820 reported completion tokens, `stop`), with no tool calls.
The old Claude request also succeeded during this check: the original refusal
is not deterministic, and these results do not establish its upstream cause or
guarantee that a provider will never refuse. The fixes remove internal-data
serialization, classify refusals correctly, and recover from unexpected summary
tool calls without reducing normal model/tool capabilities.

Official reference: https://developers.openai.com/api/docs/guides/error-codes
