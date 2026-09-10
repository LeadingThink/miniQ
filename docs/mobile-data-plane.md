# Mobile History and Private Object Data Plane

## History

`session.open` returns session state and the newest 40 timeline records. Its
`nextCursor` is passed as `before` to `session.history`; limits are 1 through 100.
The stable cursor contains the timestamp and record ID, so ties do not lose data.
Tool records are headers with `payloadDeferred: true`. `tool.detail` requires both
the session ID and tool ID and returns the complete payload after ownership checks.

History filters (`all`, `answers`, `activity`, `errors`) and text search run against
the complete stored history. Export iterates pages with `includePayloads` and
`includeInternal`, not just the loaded UI. Expanding a tool group shows 30 steps
per page; failed historical groups are initially collapsed.

The frontend and daemon must be updated together. Reload already-open mobile
pages after deployment so the new history controls are available.

## File previews and follow-up

Browser clients use the same document renderers as the desktop. Session links,
artifact cards, and the project-file picker open Markdown/text/code, PDF, DOCX,
XLSX/CSV, PPTX, images, audio, video, and standalone HTML. The picker browses
the selected session's working directory and attached project roots, with 100
entries per page. Broken or unreadable entries remain visible as unavailable;
symlinks leading outside the authorized roots are excluded.

`file.describe {sessionId,path}` returns format, byte length, revision, and chunk
size without sending file content. `file.read {sessionId,path,revision,offset}`
returns at most 3 MiB of raw bytes encoded as base64. A revision change aborts the
read rather than mixing file versions. `file.list {sessionId,path?,after?}` returns
the next directory page. All three methods resolve authority from the persisted
session/workspace; callers cannot inject allowed roots. They require the existing
authenticated local or encrypted remote connection. No public file server or
filesystem bridge is exposed. Bulk replies use the existing private-object data
plane when available.

File contents are fetched only when opened; closing a preview, opening another
file, or changing sessions aborts further chunks. UTF-8 decoding is streamed
across chunk boundaries. The mobile file preview/download limit is 64 MiB per
file, with an explicit error and no partial content. Files above that limit need a
smaller preview copy or splitting. This is chunked transfer into bounded browser
memory, not HTTP range streaming for arbitrarily large videos. Media playback
also depends on the browser's codec support.

The download action saves original bytes to the current device. The follow-up
action appends the exact file path to the current session's existing draft and
focuses the composer; it never sends a model request automatically. Native-only
open/reveal actions are hidden on browser clients.

Remote HTML bundles ordinary relative images, media, stylesheets, CSS `url()`
assets, and static script files into an iframe with `allow-scripts` but no shared
origin or RPC access. Combined HTML/resources are limited to 64 MiB. External
network access remains an explicit preview toggle. This is a standalone artifact
preview, not a web-project dev server: module imports, dynamic relative fetches,
CSS imports, and responsive `srcset` resources are not bundled.

For isolated browser acceptance, run `cargo run -p miniq-daemon --example
mobile_preview -- <fixture-directory>` and connect the frontend to the printed
loopback port using the example's `isolated-preview` token. It uses an in-memory
store and mock provider; user sessions and running tasks are untouched.

## Reconnect and Scheduling

Each daemon process has an event epoch and monotonically increasing sequence.
`session.open` includes an event cursor captured while live text emission is
paused. Events arriving during the snapshot are buffered and reconciled by that
cursor. `session.sync` returns only missed events for the selected session.
The journal holds at most 4096 events / 8 MiB; an expired cursor explicitly asks
for a new paged snapshot. It never silently drops durable conversation history.

Remote peers subscribe to their selected session, plus lightweight sidebar
events for other sessions. Local WebSocket consumers retain complete live tool
events; remote events defer tool bodies. Desktop reconnection has an independent
connection identity, allowing mobiles to resync even when their socket stays open.

Cancellation stops history/download transport, not agent tasks. RPC replies can
pass queued bulk transfers, with a bounded priority burst to prevent starvation.
Event batches retain ordering, heartbeat responses have priority, and all data
frames share the relay rate budget. Gzip is negotiated and applied before AES-GCM.

## Private Qiniu Objects

Payloads of at least 128 KiB after compression can use private Qiniu S3 objects.
The desktop requests a scoped ticket, uploads AES-GCM ciphertext directly, and
sends the authenticated object reference over the encrypted relay. The mobile
downloads independently of the WebSocket event queue, checks length and SHA-256,
then authenticates/decrypts with its existing end-to-end key. The key and plaintext
are never sent to storage. Signed links expire after five minutes.

The relay uses the official Qiniu and AWS S3 SDKs. Its optional configuration is
loaded from `/etc/miniq-relay/blob.env`, owned by root with mode 0600:

```text
MINIQ_BLOB_ACCESS_KEY=<server-only access key>
MINIQ_BLOB_SECRET_KEY=<server-only secret key>
MINIQ_BLOB_BUCKET=<dedicated private bucket>
MINIQ_BLOB_ENDPOINT=<HTTPS Qiniu S3 endpoint returned by region discovery>
MINIQ_BLOB_REGION=<S3 region alias returned by region discovery>
MINIQ_BLOB_ALLOWED_ROOMS=<comma-separated authorized room hashes>
```

Never reuse the public installer bucket. The relay verifies private access and a
one-day lifecycle rule for `remote/` before issuing tickets. Configure a storage
quota and CORS for the mobile site's exact origin, allowing GET/HEAD only.
Anonymous access must fail. Each object is capped at 64 MiB, and each authorized
desktop at 128 MiB of tickets per minute. The allowlist is required because a
relay room alone does not validate the provider account's billing entitlement.

Other rooms and payload sizes keep using encrypted WebSocket chunks. An object
service outage also uses that bounded transport; download failures affect only
their request and expose a retry action, not a connection restart. The browser
enforces a 256 MiB decoded-message safety limit and rejects invalid lengths.

## Deployment

Build and test the relay and desktop frontend, then build the matching daemon and
native desktop bundle. Keep prior web assets available for existing tabs' dynamic
imports and preserve the previous service directory for rollback. Install the
local app only after confirming both primary turns and child agents are idle,
with a complete app/data backup and SQLite integrity check. This change does not
publish a new application version or updater manifest.
