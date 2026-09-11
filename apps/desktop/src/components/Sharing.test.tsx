// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { SessionShareDialog } from "./SessionShareDialog";
import { SharedMarkdown } from "./SharedMarkdown";
import { SharedSessionPage } from "./SharedSessionPage";
import { loadShare, sharedSessionId } from "../sharing";

vi.mock("./MarkdownCodeBlock", () => ({ MarkdownCodeBlock: ({ children }: { children: React.ReactNode }) => <pre>{children}</pre> }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const id = "a".repeat(32);
const link = { id, url: `https://oneapi.zaiwenai.com/miniq/?share=${id}`, title: "分享测试", createdAt: "2026-09-11", expiresAt: "2026-10-11", published: true, files: [], messageCount: 1 };
const messages = [
  { id: "m1", sessionId: "s1", role: "user", content: "帮我做报告", createdAt: "2026-09-11T00:00:00Z" },
  { id: "m2", sessionId: "s1", role: "assistant", content: "报告已完成", createdAt: "2026-09-11T00:01:00Z" },
];

it("shares only selected messages and explicitly selected artifacts, and revokes by session", async () => {
  const call = vi.fn(async (method: string) => {
    if (method === "session.history") return { messages, toolCalls: [], nextCursor: null };
    if (method === "session.shareList") return { shares: [link], nextCursor: null };
    if (method === "session.shareCreate") return link;
    return { ok: true };
  });
  render(<SessionShareDialog client={{ call } as unknown as RpcClient} sessionId="s1" title="报告" artifacts={[{ id: "a1", sessionId: "s1", title: "报告.pdf", path: "/private/report.pdf", kind: "pdf", createdAt: "2026-09-11" }]} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "分享第 1 条消息" }));
  expect(screen.getByRole("checkbox", { name: "报告.pdf" }).getAttribute("checked")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "生成分享链接" }));
  await screen.findByDisplayValue(link.url);
  expect(call).toHaveBeenCalledWith("session.shareCreate", expect.objectContaining({ sessionId: "s1", messageIds: ["m2"], artifactIds: [], expiresInDays: 30 }), expect.any(Object));
  fireEvent.click(screen.getByRole("button", { name: "撤销分享" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("session.shareRevoke", { sessionId: "s1", id }));
  await waitFor(() => expect(screen.queryByDisplayValue(link.url)).toBeNull());
});

it("remounts selection when sessions change and includes earlier messages only after loading them", async () => {
  const call = vi.fn(async (method: string, params?: { sessionId?: string; before?: unknown }) => {
    if (method === "session.shareList") return { shares: [], nextCursor: null };
    if (params?.sessionId === "s2") return { messages: [{ ...messages[0], id: "other", content: "独立会话" }], toolCalls: [], nextCursor: null };
    return { messages: params?.before ? [messages[0]] : [messages[1]], toolCalls: [], nextCursor: params?.before ? null : { id: "m2", at: "2026-09-11" } };
  });
  const props = { client: { call } as unknown as RpcClient, title: "测试", artifacts: [], onClose: () => {} };
  const ui = render(<SessionShareDialog {...props} sessionId="s1" />);
  await screen.findByText("已选 1 条消息");
  fireEvent.click(screen.getByRole("button", { name: "加载更早的消息并加入选择" }));
  await screen.findByText("已选 2 条消息");
  ui.rerender(<SessionShareDialog {...props} sessionId="s2" />);
  await screen.findByText("已选 1 条消息");
  expect(screen.queryByRole("checkbox", { name: "分享第 2 条消息" })).toBeNull();
});

it("public markdown has no desktop access, raw HTML execution or external image fetching", () => {
  const file = { id: "b".repeat(32), name: "report.pdf", size: 10 }; const onFile = vi.fn();
  const { container } = render(<SharedMarkdown files={[file]} onFile={onFile}>{`[文件](miniq-file:${file.id})\n[本地](/etc/passwd)\n[脚本](javascript:alert(1))\n![跟踪](https://tracker.test/pixel)\n<script>window.bad=1</script>`}</SharedMarkdown>);
  expect(container.querySelector("script, img, a[href='/etc/passwd'], a[href^='javascript:']")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "文件" })); expect(onFile).toHaveBeenCalledWith(file);
});

it("opens shared links without a login and gives a useful expired-link error", async () => {
  expect(sharedSessionId(`?share=${id}`)).toBe(id);
  expect(sharedSessionId("?share=../../settings")).toBe("invalid");
  expect(sharedSessionId("")).toBeNull();
  const fetcher = vi.fn().mockResolvedValue({ status: 404, ok: false }); vi.stubGlobal("fetch", fetcher);
  await expect(loadShare(id, 0, new AbortController().signal)).rejects.toThrow("已撤销");
  expect(fetcher).toHaveBeenCalledWith(`/miniq-relay/shares/${id}?page=0`, expect.objectContaining({ credentials: "omit", cache: "no-store" }));
});

it("clears the previous page while loading the next page of a public share", async () => {
  let finish: (value: Response) => void;
  const page = { ...link, messageCount: 51, messages: [{ ...messages[0], content: "第一页内容" }], nextPage: 1 };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page)))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; })));
  render(<SharedSessionPage id={id} />);
  await screen.findByText("第一页内容");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.queryByText("第一页内容")).toBeNull();
  expect(screen.queryByText("第 2 页")).toBeNull();
  finish!(new Response(JSON.stringify({ ...page, messages: [{ ...messages[1], content: "第二页内容" }], nextPage: null })));
  await screen.findByText("第二页内容");
  expect(screen.getByText("第 2 页")).toBeTruthy();
});
