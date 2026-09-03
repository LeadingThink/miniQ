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
