import { expect, vi } from "vitest";
import { RpcClient } from "../rpc";
import { decryptRemotePayload, deriveRemoteIdentity, encryptRemotePayload } from "../remoteCrypto";

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(_url: string) { FakeWebSocket.instances.push(this); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  send(payload: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket closed");
    this.sent.push(payload);
  }
  receive(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

export async function remoteClient() {
  const client = new RpcClient();
  const info = { kind: "remote" as const, apiKey: "test-only-key", relayUrl: "ws://relay.test/ws", deviceId: "mobile-test", deviceName: "test" };
  const connected = client.connect(info);
  const concurrent = client.connect(info);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.receive({ type: "ready", desktopOnline: true });
  await connected;
  await concurrent;
  const { encryptionKey } = await deriveRemoteIdentity(info.apiKey);
  const receive = async (payload: unknown) => {
    const encrypted = await encryptRemotePayload(encryptionKey, payload);
    socket.receive({ type: "frame", ...encrypted });
  };
  const sent = async (index: number) => {
    const envelope = JSON.parse(socket.sent[index]);
    return decryptRemotePayload<Record<string, unknown>>(encryptionKey, envelope.nonce, envelope.ciphertext);
  };
  return { client, socket, receive, sent };
}
