// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileEntry } from "./MobileEntry";
import * as mobileChatData from "../mobileChatData";
import { readMobileEntryMode } from "../mobileEntryMode";

vi.mock("./Md", () => ({ Md: ({ children }: { children: string }) => <div>{children}</div> }));
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ data: [{ id: "custom-chat", model_type: "chat" }] }), { status: 200 }))));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("lets users draft before configuration, opens daily settings and returns with the draft and default model", async () => {
  render(<MobileEntry onRemote={() => {}} />);
  expect(screen.getByRole("link", { name: /隐私政策/ }).getAttribute("href")).toBe("https://chat.zaiwenai.com/miniq/privacy");
  expect(screen.getByRole("link", { name: "技术支持" }).getAttribute("href")).toBe("https://chat.zaiwenai.com/miniq/support");
  expect(screen.queryByPlaceholderText("sk-...")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /移动问答/ }));
  const draft = await screen.findByRole("textbox", { name: "输入问题或任务" });
  fireEvent.change(draft, { target: { value: "未发送的草稿" } });
  expect(fetch).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "前往设置" }));
  expect(screen.getByText(/电脑执行任务所用的模型与服务商/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: "sk-review-key" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "我已阅读并同意" }));
  fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
  await screen.findByText("custom-chat");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "输入问题或任务" }).value).toBe("未发送的草稿");
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
  expect(sessionStorage.getItem("miniq.remote.credentials.v1")).toContain("sk-review-key");
  expect(localStorage.getItem("miniq.mobile.privacyConsent.v1")).toBe("2026-09-16");
  expect(readMobileEntryMode()).toBe("chat");
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  fireEvent.click(screen.getByRole("button", { name: /远程桌面/ }));
  expect(readMobileEntryMode()).toBe("remote");
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  fireEvent.click(screen.getByRole("button", { name: /移动问答/ }));
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("未发送的草稿"));
});

it("keeps unsaved key edits when leaving settings and does not use them for requests", async () => {
  render(<MobileEntry initialMode="chat" onRemote={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "设置" }));
  fireEvent.change(screen.getByPlaceholderText("sk-..."), { target: { value: "unsaved-key" } });
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  await screen.findByRole("button", { name: "前往设置" });
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("附加图片"), { target: { files: [new File(["image"], "draft.png", { type: "image/png" })] } });
  await screen.findByText("draft.png");
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.getByPlaceholderText<HTMLInputElement>("sk-...").value).toBe("unsaved-key");
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(await screen.findByText("draft.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "移除图片" }));
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  await screen.findByRole("button", { name: "前往设置" });
  expect(screen.queryByText("draft.png")).toBeNull();
});


it("keeps the in-memory text draft across settings and purpose selection when localStorage writes fail", async () => {
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  render(<MobileEntry initialMode="chat" onRemote={vi.fn()} />);
  const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "输入问题或任务" });
  fireEvent.change(composer, { target: { value: "只在内存中的草稿" } });
  expect(write).toHaveBeenCalledWith("miniq.draft.mobile-chat", "只在内存中的草稿");
  expect(localStorage.getItem("miniq.draft.mobile-chat")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.queryByRole("textbox", { name: "输入问题或任务" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "输入问题或任务" }).value).toBe("只在内存中的草稿");
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  fireEvent.click(screen.getByRole("button", { name: /移动问答/ }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "输入问题或任务" }).value).toBe("只在内存中的草稿");
});

it.each([true, false])("keeps an image read in flight across settings (complete while hidden: %s)", async (completeWhileHidden) => {
  let finish!: (image: mobileChatData.PendingMobileImage) => void;
  vi.spyOn(mobileChatData, "readMobileImage").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<MobileEntry initialMode="chat" onRemote={vi.fn()} />);
  await screen.findByRole("textbox", { name: "输入问题或任务" });
  fireEvent.change(screen.getByLabelText("附加图片"), { target: { files: [new File(["image"], "pending.png", { type: "image/png" })] } });
  expect(mobileChatData.readMobileImage).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  if (!completeWhileHidden) fireEvent.click(screen.getByRole("button", { name: "返回" }));
  await act(async () => { finish({ name: "pending.png", dataUrl: "data:image/png;base64,aW1hZ2U=" }); });
  if (completeWhileHidden) fireEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(screen.getByText("pending.png")).toBeTruthy();
  expect(screen.getByRole("button", { name: "移除图片" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "移除图片" }));
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  expect(screen.queryByText("pending.png")).toBeNull();
});
