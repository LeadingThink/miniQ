# miniQ Relay

The relay connects a miniQ desktop daemon to mobile browsers behind NAT. It
only routes authenticated, end-to-end encrypted WebSocket frames. Provider API
keys, JSON-RPC requests, session content, tool output, and local files are not
stored or logged by this service.

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
