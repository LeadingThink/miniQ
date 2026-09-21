// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { ComposerCard } from "./Composer";

vi.mock("./VoiceInput", () => ({ VoiceInput: () => null }));
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

function setup(extra: Partial<React.ComponentProps<typeof ComposerCard>> = {}) {
  const onSend = vi.fn().mockResolvedValue(true);
  const props = { busy: false, placeholder: "消息", draftKey: "mobile-session", onSend, ...extra };
  const view = render(<ComposerCard {...props} />);
  return { ...view, props, onSend, input: screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }) };
}

it("inserts a soft-keyboard newline without sending, then sends the entire draft from the button", async () => {
  const { input, onSend } = setup();
  fireEvent.change(input, { target: { value: "第一行下一行" } });
  input.setSelectionRange(3, 3);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("第一行\n下一行");
  expect(input.getAttribute("enterkeyhint")).toBe("enter");
  expect(screen.getByText("回车换行，点击发送按钮")).toBeTruthy();
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith("第一行\n下一行", []);
});

it.each([{ ctrlKey: true }, { metaKey: true }])("keeps external keyboard send shortcuts %j", async (modifiers) => {
  const { input, onSend } = setup();
  fireEvent.change(input, { target: { value: "完整请求" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter", ...modifiers }));
  expect(onSend).toHaveBeenCalledExactlyOnceWith("完整请求", []);
});

it("does not insert or send an IME candidate confirmation", () => {
  const { input, onSend } = setup();
  fireEvent.change(input, { target: { value: "中文候选" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(input.value).toBe("中文候选");
  expect(onSend).not.toHaveBeenCalled();
});

it("exposes remote file attachment in the phone browser and persists the full Windows path", async () => {
  const client = { mode: "remote", call: vi.fn().mockResolvedValue({ skills: [] }) } as unknown as RpcClient;
  const { onSend } = setup({ client });
  fireEvent.click(screen.getByRole("button", { name: "附加远程文件" }));
  const dialog = screen.getByRole("dialog", { name: "附加远程文件" });
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "C:\\文档\\需要审核的完整报告.pdf" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("需要审核的完整报告.pdf")).toBeTruthy();
  expect(localStorage.getItem("miniq.draft.mobile-session.attachments")).toContain("需要审核的完整报告.pdf");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith("", ["C:\\文档\\需要审核的完整报告.pdf"]);
});

it("keeps the draft while sending is blocked and prevents repeated pending sends", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const view = setup({ sendBlocked: true, onSend });
  fireEvent.change(view.input, { target: { value: "不能丢失的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("草稿会保留");
  view.rerender(<ComposerCard {...view.props} sendBlocked={false} />);
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  fireEvent.keyDown(view.input, { key: "Enter", ctrlKey: true });
  expect(onSend).toHaveBeenCalledTimes(1);
  await act(async () => finish(false));
  expect(view.input.value).toBe("不能丢失的草稿");
  expect(localStorage.getItem("miniq.draft.mobile-session")).toBe("不能丢失的草稿");
});
