// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";

const fake = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), preview: vi.fn().mockRejectedValue(new Error("preview unavailable")) }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../localFiles", () => ({ savePastedFile: fake.save, readImagePreview: fake.preview }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: fake.open }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent: async () => () => {} }) }));
afterEach(() => { cleanup(); window.localStorage.clear(); vi.clearAllMocks(); });

const props = { busy: false, placeholder: "消息", onSend: vi.fn() };

it("disables local attachments for a cloud composer and sends long pasted text without losing content", async () => {
  const onSend = vi.fn().mockResolvedValue(true), onError = vi.fn();
  render(<ComposerCard {...props} attachmentsEnabled={false} onSend={onSend} onError={onError} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.paste(input, { clipboardData: {
    files: [new File(["private"], "local.txt", { type: "text/plain" })], items: [], getData: () => "",
  } });
  expect(onError).toHaveBeenCalledWith("此会话暂不支持上传附件");
  expect(fake.save).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "附加文件" })).toBeNull();
  const text = "完整文字🌍".repeat(400);
  fireEvent.paste(input, { clipboardData: { files: [], items: [], getData: () => text } });
  expect(input.value).toBe(text);
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(onSend).toHaveBeenCalledWith(text, []));
  expect(fake.save).not.toHaveBeenCalled();
});

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

it("inserts short text copied from the conversation directly into the draft", () => {
  render(<ComposerCard {...props} draftKey="paste-outside-text" />);
  expect(document.activeElement).toBe(document.body);
  const event = pasteOutside(document.body, { text: "复制自上文的一段话" });
  expect(event.defaultPrevented).toBe(true);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  expect(input.value).toBe("复制自上文的一段话");
  expect(screen.queryByRole("button", { name: /展开粘贴内容/ })).toBeNull();
  expect(window.localStorage.getItem("miniq.draft.paste-outside-text")).toContain("复制自上文的一段话");
});

it("inserts a paste of up to 500 characters directly into the draft", () => {
  render(<ComposerCard {...props} draftKey="paste-500-characters" />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  const text = "字".repeat(500);

  fireEvent.paste(input, {
    clipboardData: { items: [], files: [], getData: () => text },
  });

  expect(input.value).toBe(text);
  expect(screen.queryByRole("button", { name: /展开粘贴内容/ })).toBeNull();
});

it("collapses a paste from 501 through 799 characters", () => {
  render(<ComposerCard {...props} draftKey="paste-501-characters" />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  const text = "字".repeat(501);

  fireEvent.paste(input, {
    clipboardData: { items: [], files: [], getData: () => text },
  });

  expect(input.value).toBe("");
  expect(screen.getByRole("button", { name: "展开粘贴内容 501 字" })).toBeTruthy();
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

it("normalizes Windows line endings inside a direct paste", () => {
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

const longText = `第一行\r\n${"长".repeat(1200)}\r最后一行`;

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

it("sends a collapsed paste with persisted display metadata", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard {...props} draftKey="paste-send-metadata" onSend={onSend} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  fireEvent.paste(input, {
    clipboardData: { items: [], files: [], getData: () => "字".repeat(501) },
  });

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));

  expect(onSend).toHaveBeenCalledWith(
    "字".repeat(501),
    [],
    false,
    {
      content: "[粘贴内容 501 字]",
      pastes: [{ placeholder: "[粘贴内容 501 字]", text: "字".repeat(501), label: undefined }],
    },
  );
});

it("inserts text at the 800-character boundary directly into the draft", () => {
  render(<ComposerCard {...props} draftKey="paste-800-characters" />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  const boundaryText = "字".repeat(800);

  expect(fireEvent.paste(input, {
    clipboardData: { items: [], files: [], getData: () => boundaryText },
  })).toBe(false);

  expect(fake.save).not.toHaveBeenCalled();
  expect(input.value).toBe(boundaryText);
});

it("turns text above 800 characters into one complete UTF-8 attachment", async () => {
  fake.save.mockResolvedValueOnce("/cache/pasted-files/已粘贴的文本.txt");
  render(<ComposerCard {...props} draftKey="paste-801-characters" />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  const attachmentText = "字".repeat(801);

  expect(fireEvent.paste(input, {
    clipboardData: { items: [], files: [], getData: () => attachmentText },
  })).toBe(false);

  await waitFor(() => expect(fake.save).toHaveBeenCalledOnce());
  expect(await readFile(fake.save.mock.calls[0][0] as File)).toBe(attachmentText);
  expect(input.value).toBe("");
  expect(await screen.findByText("已粘贴的文本.txt")).toBeTruthy();
});

it("turns a focused long text paste into one complete UTF-8 attachment", async () => {
  fake.save.mockResolvedValueOnce("/cache/pasted-files/已粘贴的文本.txt");
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard {...props} draftKey="paste-large-focused" onSend={onSend} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "保留的问题" } });

  expect(fireEvent.paste(input, {
    clipboardData: { items: [], files: [], getData: () => longText },
  })).toBe(false);

  await waitFor(() => expect(fake.save).toHaveBeenCalledOnce());
  const file = fake.save.mock.calls[0][0] as File;
  expect(file.name).toBe("已粘贴的文本.txt");
  expect(file.type).toBe("text/plain;charset=utf-8");
  expect(await readFile(file)).toBe(longText.replace(/\r\n?/g, "\n"));
  expect(input.value).toBe("保留的问题");
  expect(screen.queryByText(/粘贴内容 \d+ 字/)).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith("保留的问题", ["/cache/pasted-files/已粘贴的文本.txt"]);
});

it("attaches an outside-focus long paste without duplicating or replacing the draft", async () => {
  fake.save.mockResolvedValueOnce("/cache/pasted-files/已粘贴的文本.txt");
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard {...props} draftKey="paste-large-outside" onSend={onSend} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "已有短正文" } });
  input.blur();

  const event = pasteOutside(document.body, { text: longText });
  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(fake.save).toHaveBeenCalledOnce());
  expect(input.value).toBe("已有短正文");
  expect(await readFile(fake.save.mock.calls[0][0] as File)).toBe(longText.replace(/\r\n?/g, "\n"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith("已有短正文", ["/cache/pasted-files/已粘贴的文本.txt"]);
});

it("sends a long paste as an attachment when the draft is empty", async () => {
  fake.save.mockResolvedValueOnce("/cache/pasted-files/已粘贴的文本.txt");
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard {...props} draftKey="paste-attachment-only" onSend={onSend} />);
  pasteOutside(document.body, { text: "文".repeat(1001) });
  await screen.findByText("已粘贴的文本.txt");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith("", ["/cache/pasted-files/已粘贴的文本.txt"]);
});

it("attaches every pasted file without a count cap", async () => {
  fake.save.mockImplementation(async (file: File) => `/cache/pasted-files/${file.name}`);
  render(<ComposerCard busy={false} placeholder="消息" draftKey="paste-cap" onSend={vi.fn()} />);
  const files = Array.from({ length: 12 }, (_, index) => new File(["pdf"], `f${index}.pdf`, { type: "application/pdf" }));
  pasteOutside(document.body, { files });
  expect(await screen.findByText("f11.pdf")).toBeTruthy();
});
