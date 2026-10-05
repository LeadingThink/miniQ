import type WebSocket from "ws";

// A peer that stops reading (tunnel, frozen app, dead TCP before the heartbeat
// notices) would otherwise grow its send buffer without bound. Daemon chunks
// are ~1 MiB on the wire, so 8 MiB is several frames of slack.
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export type OutboundSocket = Pick<WebSocket, "readyState" | "OPEN" | "bufferedAmount" | "send" | "terminate">;

export function send(socket: OutboundSocket, value: unknown): void {
  sendRaw(socket, JSON.stringify(value));
}

/** Sends a text message, terminating peers whose send buffer exceeds the limit. */
export function sendRaw(socket: OutboundSocket, value: string, maxBuffered = MAX_BUFFERED_BYTES): void {
  if (socket.readyState !== socket.OPEN) return;
  if (socket.bufferedAmount > maxBuffered) {
    console.warn(`[relay] terminating slow peer with ${socket.bufferedAmount} buffered bytes`);
    socket.terminate();
    return;
  }
  socket.send(value);
}
