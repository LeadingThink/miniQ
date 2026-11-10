// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";

const fake = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), preview: vi.fn().mockRejectedValue(new Error("preview unavailable")) }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../localFiles", () => ({ savePastedFile: fake.save, readImagePreview: fake.preview }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: fake.open }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent: async () => () => {} }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

const props = { busy: false, placeholder: "消息", onSend: vi.fn() };

/** A paste dispatched while the transcript, not the composer, owns the focus. */
function pasteOutside(target: Element, options: { text?: string; files?: File[] }) {
  const files = options.files ?? [];
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
      files,
      getData: (type: string) => (type === "text/plain" ? options.text ?? "" : ""),
    },
  });
  act(() => { target.dispatchEvent(event); });
  return event;
}

it("inserts text copied from the conversation when the composer was not focused", () => {
  render(<ComposerCard {...props} draftKey="paste-outside-text" />);
  expect(document.activeElement).toBe(document.body);
  const event = pasteOutside(document.body, { text: "复制自上文的一段话" });
  expect(event.defaultPrevented).toBe(true);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  expect(input.value).toBe("复制自上文的一段话");
  expect(document.activeElement).toBe(input);
  expect(localStorage.getItem("miniq.draft.paste-outside-text")).toBe("复制自上文的一段话");
});

it("attaches a file pasted while the conversation was focused", async () => {
  fake.save.mockResolvedValueOnce("/cache/pasted-files/1700000000-42/report.pdf");
  render(<ComposerCard {...props} draftKey="paste-outside-file" />);
  const pdf = new File(["pdf"], "report.pdf", { type: "application/pdf" });
  pasteOutside(document.body, { files: [pdf] });
  expect(await screen.findByText("report.pdf")).toBeTruthy();
  expect(fake.save).toHaveBeenCalledExactlyOnceWith(pdf);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
});

it("normalizes Windows line endings from the clipboard", () => {
  render(<ComposerCard {...props} draftKey="paste-crlf" />);
  pasteOutside(document.body, { text: "第一行\r\n第二行" });
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("第一行\n第二行");
});

it("leaves a paste in another text field to that field", () => {
  render(<ComposerCard {...props} draftKey="paste-elsewhere" />);
  const field = document.createElement("input");
  document.body.append(field);
  try {
    const event = pasteOutside(field, { text: "搜索关键词" });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).value).toBe("");
  } finally {
    field.remove();
  }
});

it("ignores a whitespace-only clipboard", () => {
  render(<ComposerCard {...props} draftKey="paste-blank" />);
  const event = pasteOutside(document.body, { text: "   \n  " });
  expect(event.defaultPrevented).toBe(false);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
});

const longText = "长".repeat(1500);

it("opens all 17575 characters, saves edits with a new count, and restores them across remounts", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ComposerCard {...props} draftKey="paste-edit" onSend={onSend} />);
  pasteOutside(screen.getByRole("textbox", { name: "消息" }), { text: "文".repeat(17575) });
  const opener = screen.getByRole("button", { name: "展开粘贴内容 17575 字" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "查看和编辑粘贴内容" });
  const editor = within(dialog).getByRole<HTMLTextAreaElement>("textbox", { name: "完整文本" });
  expect(editor.value).toBe("文".repeat(17575));
  expect(document.activeElement).toBe(editor);
  const edited = "修改开头\n" + "🙂".repeat(1800) + "\n修改结尾";
  fireEvent.change(editor, { target: { value: edited } });
  expect(within(dialog).getByRole("status").textContent).toBe("1810 字");
  fireEvent.click(within(dialog).getByRole("button", { name: "保存修改" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(screen.getByRole("button", { name: "展开粘贴内容 1810 字" })).toBeTruthy();
  view.unmount();
  render(<ComposerCard {...props} draftKey="paste-edit" onSend={onSend} />);
  fireEvent.click(screen.getByRole("button", { name: "展开粘贴内容 1810 字" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "完整文本" }).value).toBe(edited);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith(edited, []);
});

it.each(["取消", "Escape"])("discards unsaved edits with %s without intercepting modal pastes", async (action) => {
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard {...props} draftKey="paste-cancel-edit" onSend={onSend} />);
  pasteOutside(document.body, { text: longText });
  fireEvent.click(screen.getByRole("button", { name: "展开粘贴内容 1500 字" }));
  const dialog = screen.getByRole("dialog");
  const editor = within(dialog).getByRole("textbox");
  expect(pasteOutside(editor, { text: "不要拦截" }).defaultPrevented).toBe(false);
  expect(pasteOutside(dialog, { text: "不要插入后台草稿" }).defaultPrevented).toBe(false);
  fireEvent.change(editor, { target: { value: "未保存" } });
  if (action === "Escape") fireEvent.keyDown(editor, { key: "Escape" });
  else fireEvent.click(within(dialog).getByRole("button", { name: action }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith(longText, []);
});

it("edits only the selected same-length paste while preserving surrounding text", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard {...props} draftKey="paste-edit-two" onSend={onSend} />);
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "前文" } });
  pasteOutside(document.body, { text: longText });
  pasteOutside(document.body, { text: "二".repeat(1500) });
  fireEvent.click(screen.getByRole("button", { name: "展开粘贴内容 1500 字 #2" }));
  fireEvent.change(screen.getByRole("textbox", { name: "完整文本" }), { target: { value: "短文本" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  expect(screen.getByRole("button", { name: "展开粘贴内容 3 字" })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith(`前文${longText}短文本`, []);
});

it("closes the editor on session changes without applying edits to either draft", () => {
  const view = render(<ComposerCard {...props} draftKey="paste-session-a" />);
  pasteOutside(document.body, { text: longText });
  fireEvent.click(screen.getByRole("button", { name: "展开粘贴内容 1500 字" }));
  fireEvent.change(screen.getByRole("textbox", { name: "完整文本" }), { target: { value: "不能串会话" } });
  view.rerender(<ComposerCard {...props} draftKey="paste-session-b" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).value).toBe("");
  view.rerender(<ComposerCard {...props} draftKey="paste-session-a" />);
  fireEvent.click(screen.getByRole("button", { name: "展开粘贴内容 1500 字" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "完整文本" }).value).toBe(longText);
});

it("retains saved edits after a rejected send and only allows viewing during a pending send", async () => {
  let finish!: (accepted: boolean) => void;
  const onSend = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  render(<ComposerCard {...props} draftKey="paste-rejected" onSend={onSend} />);
  pasteOutside(document.body, { text: longText });
  fireEvent.click(screen.getByRole("button", { name: "展开粘贴内容 1500 字" }));
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "完整文本" });
  fireEvent.keyDown(editor, { key: "Escape", isComposing: true });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.change(editor, { target: { value: "保存后的内容" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  fireEvent.click(screen.getByRole("button", { name: "展开粘贴内容 6 字" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "完整文本" }).readOnly).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "保存修改" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await act(async () => finish(false));
  fireEvent.click(screen.getByRole("button", { name: "展开粘贴内容 6 字" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "完整文本" }).value).toBe("保存后的内容");
  expect(JSON.parse(localStorage.getItem("miniq.draft.paste-rejected.pastes")!)[0].text).toBe("保存后的内容");
});

it("collapses a long paste and restores it when the message is sent", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-large" onSend={onSend} />);
  pasteOutside(document.body, { text: longText });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  expect(screen.getByText("粘贴内容 1500 字")).toBeTruthy();
  expect(input.value).toBe("");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith(longText, []);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).value).toBe("");
  expect(screen.queryByText("粘贴内容 1500 字")).toBeNull();
});

it("places a long paste directly after preceding text or at the field start", () => {
  const first = render(<ComposerCard {...props} draftKey="paste-inline-text" />);
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
    target: { value: "粘贴测试测试，" },
  });
  pasteOutside(document.body, { text: longText });
  const chip = screen.getByText("粘贴内容 1500 字").closest(".paste-chip")!;
  const preceding = chip.previousElementSibling!;
  expect(preceding.classList.contains("is-before-paste")).toBe(true);
  expect((preceding as HTMLTextAreaElement).value).toBe("粘贴测试测试，");

  first.unmount();
  render(<ComposerCard {...props} draftKey="paste-at-start" />);
  pasteOutside(document.body, { text: longText });
  const leading = screen.getByText("粘贴内容 1500 字").closest(".paste-chip")?.previousElementSibling;
  expect(leading).toBeNull();
});

it("keeps two large pastes apart and expands each in order", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-large-twice" onSend={onSend} />);
  const second = "短".repeat(1200);
  pasteOutside(document.body, { text: longText });
  pasteOutside(document.body, { text: second });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  expect(screen.getByText("粘贴内容 1500 字")).toBeTruthy();
  expect(screen.getByText("粘贴内容 1200 字")).toBeTruthy();
  expect(input.value).toBe("");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith(`${longText}${second}`, []);
});

it("keeps the collapsed text with its draft across a remount", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-large-remount" onSend={onSend} />);
  pasteOutside(document.body, { text: longText });
  view.unmount();
  render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-large-remount" onSend={onSend} />);
  expect(screen.getByText("粘贴内容 1500 字")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith(longText, []);
});

it("forgets the hidden text once its placeholder is deleted", async () => {
  render(<ComposerCard {...props} draftKey="paste-large-deleted" />);
  pasteOutside(document.body, { text: longText });
  fireEvent.click(screen.getByRole("button", { name: "移除粘贴内容 1500 字" }));
  await waitFor(() => expect(localStorage.getItem("miniq.draft.paste-large-deleted.pastes")).toBeNull());
  expect(screen.queryByText("粘贴内容 1500 字")).toBeNull();
});

it("stops at ten attachments and reports how many were dropped", async () => {
  const onError = vi.fn();
  fake.save.mockImplementation(async (file: File) => `/cache/pasted-files/${file.name}`);
  render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-cap" onSend={vi.fn()} onError={onError} />);
  const files = Array.from({ length: 12 }, (_, index) => new File(["pdf"], `f${index}.pdf`, { type: "application/pdf" }));
  pasteOutside(document.body, { files });
  expect(await screen.findByText("f9.pdf")).toBeTruthy();
  expect(screen.queryByText("f10.pdf")).toBeNull();
  expect(onError).toHaveBeenCalledWith("每条消息最多附加 10 个文件，2 个未添加");
});
