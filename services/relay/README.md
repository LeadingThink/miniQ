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

The relay still enforces a 2 MiB WebSocket message limit and 240 routed frames
per minute per peer. The daemon leaves these safeguards intact: it batches
live events and spaces all encrypted data frames at least 350 ms apart.
WebSocket heartbeats are handled independently from RPC execution and payload
transfers. With no mobile clients, live events are not forwarded.

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
