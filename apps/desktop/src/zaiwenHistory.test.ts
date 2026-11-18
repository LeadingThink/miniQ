// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listZaiwenConversations, listZaiwenMessages } from "./zaiwenHistory";
import { ZaiwenApiError } from "./zaiwenApi";

const session = { token: "private-token", user: { uid: "owner" } };
const conversation = { id: "conversation-1", title: "云端会话", created: 1_700_000_000 };
function reply(data: unknown, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ code: 0, data, next_cursor: null, ...extra }), { status: 200 });
}

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

it("uses only authenticated GET requests for cloud history, preserving opaque cursors", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(reply([conversation], { total: 2, next_cursor: "opaque+/=" }))
    .mockResolvedValueOnce(reply([{ id: "m1", role: "assistant", content: "完整内容", created: 1_700_000_001 }], { total: 1 }));
  const abort = new AbortController();
  expect(await listZaiwenConversations(session, null, abort.signal)).toEqual({ items: [conversation], total: 2, cursor: "opaque+/=" });
  await listZaiwenMessages(session, "会话 / ?", "opaque+/=", abort.signal);
  const calls = vi.mocked(fetch).mock.calls;
  expect(new URL(String(calls[0][0])).pathname).toBe("/api/v1/ai/conversations");
  const messageUrl = new URL(String(calls[1][0]));
  expect(messageUrl.pathname).toBe("/api/v1/ai/messages");
  expect(messageUrl.searchParams.get("conversation_id")).toBe("会话 / ?");
  expect(messageUrl.searchParams.get("cursor")).toBe("opaque+/=");
  expect(messageUrl.searchParams.has("skip")).toBe(false);
  for (const [url, init] of calls) {
    expect(new URL(String(url)).origin).toBe("https://back.zaiwenai.com");
    expect(String(url)).not.toContain(session.token);
    expect(init).toMatchObject({ method: "GET", cache: "no-store", signal: abort.signal });
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("token")).toBe(session.token);
    expect(new Headers(init?.headers).get("channel")).toBe("web.zaiwenai.com");
  }
});

it("accepts an empty messages response whose zero total is omitted by the server", async () => {
  vi.mocked(fetch).mockResolvedValue(reply([]));
  await expect(listZaiwenMessages(session, "empty")).resolves.toEqual({ items: [], total: 0, cursor: null });
});

it.each([
  { total: -1 }, { total: "2" }, { next_cursor: "" }, { next_cursor: 5 },
  { data: [{ ...conversation, id: "" }] }, { data: [{ ...conversation, created: "invalid" }] },
  { data: [{ ...conversation, title: 123 }] },
])("rejects invalid pages rather than silently dropping records: %j", async (extra) => {
  vi.mocked(fetch).mockResolvedValue(reply([conversation], { total: 1, ...extra }));
  await expect(listZaiwenConversations(session)).rejects.toThrow();
});

it("rejects a non-advancing cursor", async () => {
  vi.mocked(fetch).mockResolvedValue(reply([conversation], { total: 5, next_cursor: "same" }));
  await expect(listZaiwenConversations(session, "same")).rejects.toThrow("分页信息无效");
});

it("keeps long messages and rich payloads intact", async () => {
  const message = { id: "long", role: "assistant", created: 1_700_000_000,
    content: "长内容".repeat(50000), draw_result: { images: [{ url: "https://example.test/image.png" }] } };
  vi.mocked(fetch).mockResolvedValue(reply([message], { total: 1 }));
  expect((await listZaiwenMessages(session, "long")).items).toEqual([message]);
});

it.each([401, 200])("recognizes expired login from HTTP or application errors (%s)", async (status) => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ code: "02401", msg: "expired" }), { status }));
  try { await listZaiwenConversations(session); throw new Error("expected failure"); }
  catch (error) {
    expect(error).toBeInstanceOf(ZaiwenApiError);
    expect((error as ZaiwenApiError).requiresLogin).toBe(true);
  }
});
