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

Official reference: https://developers.openai.com/api/docs/guides/error-codes
