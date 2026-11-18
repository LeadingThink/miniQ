import { expect, it, vi } from "vitest";
import { listZaiwenMessages } from "./zaiwenHistory";
import { readZaiwenTranscript } from "./zaiwenSessionView";

vi.mock("./zaiwenHistory", async (original) => ({
  ...await original<typeof import("./zaiwenHistory")>(), listZaiwenMessages: vi.fn(),
}));
const session = { token: "test", user: { uid: "owner" } };

it("exports every cloud page in order with full text and rich source data", async () => {
  const recent = { id: "recent", created: 1700000001, role: "assistant", content: "回答".repeat(15000), type: "pptx", ppt_result: "opaque" };
  const older = { id: "older", created: 1700000000, role: "user", content: "原始问题", assets: [{ url: "https://example.test/image.png" }] };
  vi.mocked(listZaiwenMessages).mockReset().mockResolvedValueOnce({ items: [recent], total: 2, cursor: "next" })
    .mockResolvedValueOnce({ items: [older, recent], total: 2, cursor: null });
  const signal = new AbortController().signal;
  const result = await readZaiwenTranscript(session, "cloud", "cloud-view", signal);
  expect(result.messages.map((message) => message.id)).toEqual(["older", "recent"]);
  expect(result.messages[1].content).toBe(recent.content);
  expect(result.messages[1].zaiwen).toEqual(recent);
  expect(result.messages[0].zaiwen.assets).toEqual(older.assets);
  expect(listZaiwenMessages).toHaveBeenLastCalledWith(session, "cloud", "next", signal);
});

it("fails an export on cyclic pagination rather than returning incomplete history", async () => {
  vi.mocked(listZaiwenMessages).mockReset().mockResolvedValue({ items: [], total: 1, cursor: "same" });
  await expect(readZaiwenTranscript(session, "cloud", "view", new AbortController().signal)).rejects.toThrow("分页重复");
});

it("does not request export pages after cancellation", async () => {
  vi.mocked(listZaiwenMessages).mockReset();
  const controller = new AbortController();
  controller.abort();
  await expect(readZaiwenTranscript(session, "cloud", "view", controller.signal)).rejects.toThrow();
  expect(listZaiwenMessages).not.toHaveBeenCalled();
});
