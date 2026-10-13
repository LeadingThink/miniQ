import type { IncomingMessage, ServerResponse } from "node:http";
import { isProviderMediaContentType, MAX_PROVIDER_MEDIA_BYTES, type TicketIssuer } from "./blobStore.js";
import { ObjectByteBudget } from "./rateLimit.js";
import { type ShareAuth } from "./shareHttp.js";
import { shareOwner } from "./shareStore.js";

/** Small authenticated control endpoint. Media bytes go directly to storage. */
export class ProviderMediaHttp {
  private readonly budgets = new Map<string, { budget: ObjectByteBudget; seen: number }>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  constructor(private readonly store: TicketIssuer, private readonly authenticate: ShareAuth) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.method !== "POST") return send(405, { error: "POST required" });
      const now = Date.now();
      for (const [id, item] of this.attempts) if (item.until <= now) this.attempts.delete(id);
      const address = request.socket.remoteAddress ?? "unknown";
      const attempt = this.attempts.get(address) ?? { count: 0, until: now + 60_000 };
      if (this.attempts.size >= 2000 && !this.attempts.has(address)) return send(429, { error: "Too many requests" });
      this.attempts.set(address, attempt);
      if (++attempt.count > 120) return send(429, { error: "Too many requests" });
      const key = request.headers.authorization?.match(/^Bearer (\S{8,512})$/)?.[1];
      if (!key) return send(401, { error: "Valid OneAPI key required" });
      if (!this.store.authenticatedMediaTicket) return send(503, { error: "Media storage unavailable" });
      if (!await this.authenticate(key)) return send(401, { error: "Invalid OneAPI key" });
      let text = "";
      let size = 0;
      for await (const part of request.iterator({ destroyOnReturn: false })) {
        size += Buffer.byteLength(part);
        if (size > 4096) { request.resume(); response.setHeader("connection", "close"); return send(413, { error: "Ticket request too large" }); }
        text += part.toString();
      }
      let body: Record<string, unknown>;
      try { body = JSON.parse(text); } catch { return send(400, { error: "Invalid JSON" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(k => !["bytes", "contentType"].includes(k))
        || !Number.isSafeInteger(body.bytes) || (body.bytes as number) < 1
        || (body.bytes as number) > MAX_PROVIDER_MEDIA_BYTES
        || !isProviderMediaContentType(body.contentType)) return send(400, { error: "Invalid media type or size" });
      const owner = shareOwner(key);
      for (const [id, item] of this.budgets) if (now - item.seen > 60_000) this.budgets.delete(id);
      if (this.budgets.size >= 2000 && !this.budgets.has(owner)) return send(429, { error: "Media quota unavailable" });
      const record = this.budgets.get(owner) ?? { budget: new ObjectByteBudget(now, 512 * 1024 * 1024), seen: now };
      record.seen = now;
      this.budgets.set(owner, record);
      const reservation = record.budget.reservation(body.bytes as number, now);
      if (!reservation) return send(429, { error: "Media byte limit reached; try later" });
      try {
        const ticket = await this.store.authenticatedMediaTicket(owner, body.bytes as number, body.contentType);
        send(200, { ticket: { putUrl: ticket.putUrl, getUrl: ticket.getUrl, expiresAt: ticket.expiresAt } });
      } catch {
        reservation.release();
        send(503, { error: "Media storage unavailable" });
      }
    } catch {
      // SDK errors can include credentials or signed URLs. Never forward them.
      if (!response.headersSent) send(503, { error: "Media storage unavailable" });
      else response.destroy();
    }
  }
}
