// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

it("collapses a long paste and restores it when the message is sent", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-large" onSend={onSend} />);
  pasteOutside(document.body, { text: longText });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  expect(input.value).toBe("[粘贴内容 1500 字]");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith(longText, []);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).value).toBe("");
});

it("keeps two large pastes apart and expands each in order", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-large-twice" onSend={onSend} />);
  const second = "短".repeat(1200);
  pasteOutside(document.body, { text: longText });
  pasteOutside(document.body, { text: second });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  expect(input.value).toBe("[粘贴内容 1500 字][粘贴内容 1200 字]");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith(`${longText}${second}`, []);
});

it("keeps the collapsed text with its draft across a remount", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-large-remount" onSend={onSend} />);
  pasteOutside(document.body, { text: longText });
  view.unmount();
  render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-large-remount" onSend={onSend} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  expect(input.value).toBe("[粘贴内容 1500 字]");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith(longText, []);
});

it("forgets the hidden text once its placeholder is deleted", async () => {
  render(<ComposerCard {...props} draftKey="paste-large-deleted" />);
  pasteOutside(document.body, { text: longText });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "只保留这句" } });
  await waitFor(() => expect(localStorage.getItem("miniq.draft.paste-large-deleted.pastes")).toBeNull());
  expect(input.value).toBe("只保留这句");
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
