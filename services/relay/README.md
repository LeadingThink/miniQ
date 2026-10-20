# miniQ Relay

The relay connects a miniQ desktop daemon to mobile browsers behind NAT. It
routes authenticated, end-to-end encrypted WebSocket frames. Provider API
keys, JSON-RPC requests, session content, tool output, and local files are not
stored or logged by this service.

Explicitly published conversation shares use a separate HTTP service described
below. They are public snapshots, not part of the encrypted remote session.

Production endpoint: `wss://oneapi.zaiwenai.com/miniq-relay/ws`.

```bash
npm ci
npm run build
npm test
npm start
```

The reverse proxy must strip `/miniq-relay` before forwarding to
`127.0.0.1:9200`. `/health` is available for local health checks.

## Payload Transport

The relay accepts ciphertext up to 2 MiB per frame (oversize frames get an
explicit `frame_too_large` error). Each peer has a token bucket: desktops may
burst 600 messages and sustain 30/s, phones burst 240 and sustain 4/s. Excess
desktop messages are dropped and logged (never answered with `error`, which
would make the daemon reconnect); an over-limit phone is rejected with
`rate_limited`. Peers with more than 8 MiB of unsent data are terminated. The
daemon spaces all encrypted data frames at least 350 ms apart and batches live
events. The relay pings every 15 s, independently from RPC execution and
payload transfers. `desktop_goodbye` closes the room immediately instead of
waiting for the reconnect grace. With no mobile clients, live events are not
forwarded.

Payloads larger than 768 KiB use encrypted `remote_chunk` messages containing
`transferId`, zero-based `index`, `totalBytes`, `requestId`, and base64url `data`.
All chunks are sent in order; the receiving endpoint reconstructs the complete
UTF-8 JSON payload without truncation. RPC idle timeouts are renewed only as
valid chunks for that request arrive. An interrupted transfer is discarded
with its socket and retried by the normal session snapshot sync.

`remote_batch` contains an ordered `items` array of events. `remote_resync`
requests a fresh snapshot if the daemon's live event receiver lagged. Both
messages are encrypted before reaching the relay.

Deploy the desktop daemon and mobile web/app frontend together when updating
this endpoint transport. The relay protocol and deployment do not change;
the relay treats single payloads, chunks, and batches as opaque ciphertext.

## Private object storage and provider media tickets

Configure Qiniu S3 object storage with all of these environment variables:

```bash
MINIQ_BLOB_ACCESS_KEY=<access key>
MINIQ_BLOB_SECRET_KEY=<secret key>
MINIQ_BLOB_BUCKET=<private bucket name>
MINIQ_BLOB_ENDPOINT=https://s3-cn-east-1.qiniucs.com
MINIQ_BLOB_REGION=cn-east-1
MINIQ_BLOB_ALLOWED_ROOMS=<comma-separated room IDs>
```

Keep credentials in the service's secret environment. The endpoint must use
HTTPS and a hostname ending in `.qiniucs.com`. Without `MINIQ_BLOB_BUCKET`,
object storage is disabled; when it is set, every variable above is required.

Before starting the relay, make the bucket private and configure **three** Qiniu
lifecycle rules, each with `delete_after_days: 1`, for the exact prefixes
`remote/`, `provider-media/`, and `remote-files/`. A public bucket or failed
bucket-info request blocks all issuance. Each namespace verifies its own rule:
a missing rule disables that namespace without disabling the others. Existing
deployments must add `remote-files/` before file transfers can issue tickets.
Verification logs a generic failure without SDK URLs.
URL expiry limits access; the lifecycle rules delete the stored objects after
one day independently of URL expiry.

The existing WebSocket control exchange remains
`{ "type": "blob_ticket", "requestId": "...", "bytes": 1024 }`, answered with
`{ "type": "blob_ticket", "requestId": "...", "ticket": { "putUrl": "...", "getUrl": "...", "expiresAt": 0 } }`
or an `error` string. Only the current authenticated desktop in an allowed room
can request a ticket. Encrypted blobs use `remote/<room>/<device>/<uuid>` (the
issuer also supports the legacy key without a device component), accept
16 bytes through 64 MiB, and sign PUT with `application/octet-stream`. Both
PUT and GET URLs expire after 300 seconds; `expiresAt` is Unix time in
milliseconds.

### Remote file tickets

Desktop `ready` messages advertise `fileStorage: true` when the room is allowed
and the issuer supports files. Issuance still awaits bucket/lifecycle verification.
The current authenticated desktop sends
`{"type":"file_ticket","requestId":"file-1","bytes":1024,"sessionId":"session-1"}`.
The reply is `{"type":"file_ticket_result","requestId":"file-1","ticket":{"putUrl":"...","getUrl":"...","expiresAt":0}}`
or the same response with `error: "File transfer unavailable"` instead of `ticket`.
Failures also carry a fixed `code`: `file_ticket_forbidden`,
`file_ticket_invalid`, `file_storage_unavailable`, `file_budget_exceeded`, or
`file_storage_failed`. A budget failure includes `retryAfterMs: 60000`.
An initial request omits `objectId`; existing installed clients sending
`objectId: null` receive the same behavior. Renewals require an existing object ID
within the authenticated room, desktop and session namespace.
`requestId` must contain 1–80 characters; invalid IDs receive no response.
`sessionId` must be nonblank, at most 256 characters, and contain no ASCII control
characters. `bytes` must be an integer from zero through 209715200 (200 MiB).

Objects use `remote-files/<room>/<desktop>/<sha256(sessionId)>/<uuid>`.
Room and desktop come from the authenticated connection; callers cannot choose
an object key or a URL to sign. PUT is signed for the exact byte length and
`Content-Type: application/octet-stream`; clients must supply matching headers.
PUT and GET expire after 900 seconds; `expiresAt` is Unix milliseconds.
The file byte budget is 200 MiB per minute per room/desktop, independent of media
and RPC blobs, and persists across reconnects. Failed signing refunds the bytes.
Zero-byte requests remain subject to the connection message-rate quota.

The daemon must authorize session access and local paths before requesting a
ticket. The relay does not validate session membership, and phones cannot request
tickets directly. Never accept an arbitrary mobile-provided download/upload URL.
File contents travel directly through private object storage; the relay does not
log session IDs, signed URLs, credentials, paths, or file contents. Configure
bucket CORS for deployed mobile origins, GET/PUT and the required content headers.
The one-day lifecycle deletion is independent of the 15-minute URL expiry.

The private bucket must have a one-day deletion rule for `provider-media/`.
The existing `remote/` rule remains independent. Media objects contain raw
provider input. Remote RPC objects remain AES-GCM ciphertext.

The daemon uses `POST /provider-media/ticket` under the relay reverse proxy.
Send a OneAPI Key in the `Authorization: Bearer ...` header. Send JSON
`{"bytes":4096,"contentType":"image/png"}`. The handler validates the key through
`/v1/auth/key`, then derives an owner hash. It does not use the public model catalog
as an authentication check. Remote access does not need to be enabled.

The response is `{"ticket":{"putUrl":"...","getUrl":"...","expiresAt":0}}`.
`expiresAt` is Unix time in milliseconds. Both URLs last 900 seconds.
Upload directly to the PUT URL with the declared MIME type and byte length.
Do not send the OneAPI Key with the PUT request. Give the GET URL to the provider.
Do not log these URLs. A URL holder can read the media until the link expires.
The bucket stays private. Do not delete on task acceptance because the provider
can fetch references asynchronously. Abandoned uploads expire through the bucket rule.

HTTP objects use `provider-media/accounts/<owner-hash>/<uuid>`.
Each object is limited to 256 MiB. Each account reserves up to 512 MiB per minute.
A failed ticket issuance releases its byte reservation. An issued ticket consumes
quota even if the client does not upload. The JSON body is limited to 4096 bytes.
Unauthenticated requests are rejected before tickets are issued.

Allowed MIME types are JPEG, PNG, WebP, MP4, WebM, MOV/QuickTime, MP3/MPEG,
WAV, M4A/MP4, AAC, Ogg and FLAC. The daemon validates content before upload.
Channel limits can be narrower than storage limits.

A WebSocket `provider_media_ticket` control path remains available for whitelisted
rooms. Only the active desktop socket can request it. The request has `requestId`,
`bytes` and `contentType`. The response has `ticket` or a generic `error`.
Its separate 256 MiB/minute room-device budget survives reconnects. This path does
not open storage to arbitrary new relay rooms.

## Conversation sharing

Set `MINIQ_SHARE_DIR` to a persistent directory writable by the service user,
for example `/home/ubuntu/miniq-relay/shares`. Without it, sharing returns 503;
encrypted remote access continues to work. Back up this directory separately
from deployable `dist` assets. Keep it outside the web server's static root.

The existing `/miniq-relay/*` reverse proxy must also forward `/shares/*`,
stream uploads up to 256 MiB per file, and permit request durations of five
minutes. Do not cache share responses or log Authorization headers. Caddy's
existing streaming reverse proxy supports these routes without additional rules.

Authoring RPCs are `session.shareCreate`, `session.shareList` and
`session.shareRevoke`. Mutations validate the author's OneAPI key against the
fixed `/v1/auth/key` identity endpoint; only a domain-separated hash is persisted.
Deploy that endpoint from the OneAPI backend before enabling sharing. The public
`/v1/models` catalog is not an authentication check.
Management is isolated by a hash of the desktop device and session identifiers.
Visitors open `/miniq/?share=<id>` without a key or an online desktop.

Publication stages an immutable message snapshot, streams explicitly selected
file copies with SHA-256 verification, then makes the link public. Retry IDs
deduplicate uncertain responses. Readers get 50 complete messages per page;
media downloads support HTTP byte ranges. Selected Markdown, PDF, spreadsheets,
images, audio and video can be previewed; other formats remain downloadable.
HTML/SVG previews are static sandboxed documents. External images and local
file links are not fetched from shared Markdown.

Links expire after 7, 30 (default), or 90 days. Revocation hides the link before
removing its files. Expired snapshots and day-old unfinished uploads are cleaned
at startup and hourly. Limits fail explicitly: 16 MiB message JSON, 30 files,
256 MiB/file, 512 MiB/share, 100 active snapshots and 2 GiB files per author.
Only selected user/assistant text and selected files are published; tool payloads,
system prompts, session credentials, and subsequent messages are excluded.

Before upload, the desktop uses the author's configured OneAPI key to run a
fail-closed AI review of every selected message and each supported attachment.
Text and extractable Office/PDF content are reviewed in complete batches;
supported static images are reviewed with vision. Content that is blocked,
cannot be reviewed, times out, or returns an invalid decision is not published.

Public readers can POST a reason and optional detail to `/shares/:id/report`.
The first valid report atomically moves the snapshot out of the public
namespace, so pages and files immediately return 404. The quarantined snapshot
and `report.json` are retained for 30 days for complaint handling, then cleanup
removes them. The report endpoint is bounded and rate-limited; it never asks a
reporter to submit an API key.
