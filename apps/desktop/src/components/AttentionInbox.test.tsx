// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AttentionInbox } from "./AttentionInbox";
import { recordAttentionItem } from "../companionInbox";

const openSession = vi.fn();
vi.mock("../desktopHost", () => ({ useDesktopHost: () => ({ openSession }) }));

const app = { actions: { openSession: vi.fn() } } as never;

beforeEach(() => {
  localStorage.clear();
  openSession.mockReset();
});

it("shows unread badge and navigates without implicit approval", () => {
  recordAttentionItem({ host: null, sessionId: "s1", kind: "approval", eventKey: "approval:a1", title: "部署", detail: "允许执行命令" });
  render(<AttentionInbox app={app} />);
  expect(screen.getByLabelText("1 条未读提醒")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "打开提醒收件箱" }));
  expect(screen.getByText("打开会话后处理")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /部署/ }));
  expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));
  expect(openSession).not.toHaveBeenCalledWith(expect.objectContaining({ approve: expect.anything() }));
});

it("updates the badge after marking an item read", () => {
  recordAttentionItem({ host: null, sessionId: "s1", kind: "failed", eventKey: "turn:t1", title: "构建", detail: "失败" });
  render(<AttentionInbox app={app} />);
  fireEvent.click(screen.getByRole("button", { name: "打开提醒收件箱" }));
  fireEvent.click(screen.getByRole("button", { name: "标为已读" }));
  act(() => undefined);
  expect(screen.queryByLabelText("1 条未读提醒")).toBeNull();
});
