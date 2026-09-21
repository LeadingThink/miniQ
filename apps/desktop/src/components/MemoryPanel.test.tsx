// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { MemoryPanel, type MemoryRecord } from "./MemoryPanel";

afterEach(cleanup);
const memory: MemoryRecord = { id: "a1", workspaceId: "a", scope: "workspace", content: "只属于 A 的记忆", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z" };
function client(call: ReturnType<typeof vi.fn>) { return { call, onStatus: () => () => {} } as unknown as RpcClient; }
const page = (memories: MemoryRecord[] = [memory]) => ({ memories, nextCursor: null });

it("separates global and workspace requests and renders full content on demand", async () => {
  const fullText = "段落\n".repeat(500) + "结尾完整";
  const call = vi.fn((_method, input) => Promise.resolve(page([{ ...memory, content: input.target.scope === "global" ? "全局内容" : fullText }])));
  render(<MemoryPanel client={client(call)} workspaceId="a" />);
  const detail = await screen.findByText(/查看全文/);
  fireEvent.click(detail);
  expect(detail.closest("details")?.querySelector("pre")?.textContent).toBe(fullText);
  expect(call.mock.calls[0][1].target).toEqual({ scope: "workspace", workspaceId: "a" });
  fireEvent.click(screen.getByRole("button", { name: "全局" }));
  await screen.findAllByText("全局内容");
  expect(call.mock.calls.at(-1)?.[1].target).toEqual({ scope: "global" });
  expect(screen.queryByText(/结尾完整/)).toBeNull();
});

it("does not expose an old workspace response after switching projects", async () => {
  let resolveOld!: (value: unknown) => void;
  const call = vi.fn((_method, input) => input.target.workspaceId === "a" ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve(page([])));
  const rpc = client(call);
  const view = render(<MemoryPanel client={rpc} workspaceId="a" />);
  view.rerender(<MemoryPanel client={rpc} workspaceId="b" />);
  await screen.findByText("这个范围还没有保存记忆");
  await act(async () => resolveOld(page()));
  expect(screen.queryByText(memory.content)).toBeNull();
});

it("ignores a late page after a search and a late search after changing clients", async () => {
  let resolvePage!: (value: unknown) => void;
  let resolveSearch!: (value: unknown) => void;
  const call = vi.fn((_method, input) => input.query
    ? new Promise((resolve) => { resolveSearch = resolve; })
    : input.before ? new Promise((resolve) => { resolvePage = resolve; })
    : Promise.resolve({ ...page(), nextCursor: { id: memory.id, updatedAt: memory.updatedAt } }));
  const original = client(call);
  const view = render(<MemoryPanel client={original} workspaceId="a" />);
  await screen.findByRole("button", { name: "删除记忆" });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "搜索" } });
  fireEvent.click(screen.getByRole("button", { name: /^搜索$/ }));
  await act(async () => resolvePage(page([{ ...memory, content: "过期的第二页" }])));
  expect(screen.queryByText("过期的第二页")).toBeNull();
  const nextCall = vi.fn().mockResolvedValue(page([{ ...memory, content: "新主机内容" }]));
  view.rerender(<MemoryPanel client={client(nextCall)} workspaceId="a" />);
  await screen.findAllByText("新主机内容");
  await act(async () => resolveSearch(page([{ ...memory, content: "旧主机搜索内容" }])));
  expect(screen.queryByText("旧主机搜索内容")).toBeNull();
  expect(screen.getAllByText("新主机内容")).toHaveLength(2);
});

it("searches the selected scope and uses cursors for both page directions", async () => {
  const cursor = { updatedAt: memory.updatedAt, id: memory.id };
  const call = vi.fn((_method, input) => Promise.resolve({ memories: [{ ...memory, content: input.query ? "查询结果" : input.before ? "第二页" : "第一页" }], nextCursor: input.before ? null : cursor }));
  render(<MemoryPanel client={client(call)} workspaceId="a" />);
  await screen.findAllByText("第一页");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findAllByText("第二页");
  expect(call.mock.calls.at(-1)?.[1].before).toEqual(cursor);
  fireEvent.click(screen.getByRole("button", { name: "上一页" }));
  await screen.findAllByText("第一页");
  const search = screen.getByRole("searchbox", { name: "搜索记忆" });
  fireEvent.change(search, { target: { value: "偏好" } });
  fireEvent.keyDown(search, { key: "Enter" });
  await screen.findAllByText("查询结果");
  expect(call.mock.calls.at(-1)?.[1]).toMatchObject({ target: { scope: "workspace", workspaceId: "a" }, query: "偏好", before: null });
});

it("requires explicit confirmation, defaults focus to cancel, and deletes only the displayed version", async () => {
  const call = vi.fn((method) => Promise.resolve(method === "memory.list" ? page() : { deleted: memory.id }));
  render(<MemoryPanel client={client(call)} workspaceId="a" />);
  fireEvent.click(await screen.findByRole("button", { name: "删除记忆" }));
  let confirmation = screen.getByRole("alertdialog", { name: "删除记忆确认" });
  expect(within(confirmation).getByText(memory.content)).toBeTruthy();
  expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "取消" }));
  expect(call.mock.calls.some(([method]) => method === "memory.delete")).toBe(false);
  fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "删除记忆" }));
  confirmation = screen.getByRole("alertdialog");
  fireEvent.click(within(confirmation).getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("memory.delete", { target: { scope: "workspace", workspaceId: "a" }, id: memory.id, expectedUpdatedAt: memory.updatedAt, expectedContent: memory.content }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
});

it("retains the record on failed deletion and never resubmits automatically", async () => {
  const call = vi.fn((method) => method === "memory.list" ? Promise.resolve(page()) : Promise.reject(new Error("记忆已变化，请刷新")));
  render(<MemoryPanel client={client(call)} workspaceId="a" />);
  fireEvent.click(await screen.findByRole("button", { name: "删除记忆" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "记忆已变化，请刷新");
  expect(call.mock.calls.filter(([method]) => method === "memory.delete")).toHaveLength(1);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

it("supports global management without a project and retries failed list reads", async () => {
  const call = vi.fn().mockRejectedValueOnce(new Error("离线")).mockResolvedValue(page([]));
  render(<MemoryPanel client={client(call)} workspaceId={null} />);
  expect(screen.getByRole("button", { name: "当前项目" })).toHaveProperty("disabled", true);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "刷新记忆" }));
  await screen.findByText("这个范围还没有保存记忆");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("never submits the surrounding settings form", async () => {
  const submit = vi.fn((event) => event.preventDefault());
  const call = vi.fn().mockResolvedValue(page());
  const { container } = render(<form onSubmit={submit}><MemoryPanel client={client(call)} workspaceId="a" /></form>);
  await screen.findByRole("button", { name: "删除记忆" });
  expect(container.querySelectorAll("form")).toHaveLength(1);
  for (const button of container.querySelectorAll("button")) expect(button.type).toBe("button");
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
  expect(submit).not.toHaveBeenCalled();
});
