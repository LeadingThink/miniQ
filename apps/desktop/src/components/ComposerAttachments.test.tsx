// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";

const attachmentStyles = readFileSync(resolve(process.cwd(), "src/styles/conversation.css"), "utf8");

const fake = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn(), preview: vi.fn().mockRejectedValue(new Error("preview unavailable")) }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../localFiles", () => ({ savePastedFile: fake.save, readImagePreview: fake.preview }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: fake.open }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent: async () => () => {} }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

const props = { busy: false, placeholder: "消息", onSend: vi.fn() };
it("keeps the remove control visible beside a long attachment name", () => {
  const style = document.createElement("style");
  style.textContent = attachmentStyles;
  document.head.append(style);
  try {
    const name = "需要审核的完整报告及补充材料".repeat(8) + ".pdf";
    localStorage.setItem("miniq.draft.long-name.attachments", JSON.stringify([`/work/${name}`]));
    render(<ComposerCard {...props} draftKey="long-name" />);
    const remove = screen.getByRole("button", { name: `移除附件 ${name}` });
    const label = screen.getByText(name);
    expect(parseFloat(getComputedStyle(label).minWidth)).toBe(0);
    expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(remove).flexShrink).toBe("0");
    expect(getComputedStyle(remove).width).toBe("24px");
  } finally {
    style.remove();
  }
});

it("keeps image removal inside the thumbnail and clears the last attachment", async () => {
  fake.preview.mockResolvedValueOnce({ mimeType: "image/png", dataBase64: "aW1hZ2U=" });
  localStorage.setItem("miniq.draft.remove-image.attachments", JSON.stringify(["/work/image.png"]));
  const style = document.createElement("style");
  // jsdom does not resolve custom properties in background shorthands.
  style.textContent = attachmentStyles.replaceAll("var(--media-overlay-bg)", "#123456");
  document.head.append(style);
  try {
    render(<ComposerCard {...props} draftKey="remove-image" />);
    const remove = await screen.findByRole("button", { name: "移除图片 image.png" });
    const computed = getComputedStyle(remove);
    expect(parseFloat(computed.top)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(computed.right)).toBeGreaterThanOrEqual(0);
    expect(computed.backgroundColor).toBe("rgb(18, 52, 86)");
    fireEvent.click(remove);
    expect(screen.queryByRole("img", { name: "image.png" })).toBeNull();
    expect(localStorage.getItem("miniq.draft.remove-image.attachments")).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled).toBe(true);
  } finally {
    style.remove();
  }
});

it("removes a selected file from the preview, saved draft and outgoing message", async () => {
  fake.open.mockResolvedValueOnce(["/work/cancel.pdf", "/work/keep.pdf"]);
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ComposerCard {...props} draftKey="remove-file" onSend={onSend} />);
  fireEvent.click(screen.getByRole("button", { name: "更多输入方式" }));
  fireEvent.click(screen.getByRole("button", { name: "附加文件" }));
  await screen.findByText("cancel.pdf");
  fireEvent.click(screen.getByRole("button", { name: "移除附件 cancel.pdf" }));
  expect(screen.queryByText("cancel.pdf")).toBeNull();
  expect(JSON.parse(localStorage.getItem("miniq.draft.remove-file.attachments")!)).toEqual(["/work/keep.pdf"]);
  view.unmount();
  render(<ComposerCard {...props} draftKey="remove-file" onSend={onSend} />);
  expect(screen.queryByText("cancel.pdf")).toBeNull();
  expect(screen.getByText("keep.pdf")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith("", ["/work/keep.pdf"]);
});

it("saves late file picker results to the originating draft without changing the new session", async () => {
  let finish!: (paths: string[]) => void;
  fake.open.mockImplementationOnce(() => new Promise<string[]>((resolve) => { finish = resolve; }));
  localStorage.setItem("miniq.draft.A.attachments", JSON.stringify(["/work/original-a.pdf"]));
  localStorage.setItem("miniq.draft.B.attachments", JSON.stringify(["/work/original-b.pdf"]));
  const view = render(<ComposerCard {...props} draftKey="A" />);
  fireEvent.click(screen.getByRole("button", { name: "更多输入方式" }));
  fireEvent.click(screen.getByRole("button", { name: "附加文件" }));
  await waitFor(() => expect(fake.open).toHaveBeenCalledOnce());
  view.rerender(<ComposerCard {...props} draftKey="B" />);
  expect(screen.queryByText("正在准备附件，完成后可发送")).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled).toBe(false);
  await act(async () => finish(["/work/late-a.pdf"]));
  expect(screen.queryByText("late-a.pdf")).toBeNull();
  expect(screen.getByText("original-b.pdf")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("miniq.draft.A.attachments")!)).toEqual(["/work/original-a.pdf", "/work/late-a.pdf"]);
  expect(JSON.parse(localStorage.getItem("miniq.draft.B.attachments")!)).toEqual(["/work/original-b.pdf"]);
  view.rerender(<ComposerCard {...props} draftKey="A" />);
  expect(screen.getByText("late-a.pdf")).toBeTruthy();
});

it("waits for clipboard files before sending the text and attachments together", async () => {
  let finish!: (path: string) => void;
  fake.save.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ComposerCard {...props} draftKey="pending-attachment" onSend={onSend} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "请检查这张图" } });
  fireEvent.paste(input, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => new File(["image"], "image.png", { type: "image/png" }) }] } });
  expect(screen.getByRole("status").textContent).toContain("正在准备附件");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => finish("/work/ready.png"));
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(onSend).toHaveBeenCalledExactlyOnceWith("请检查这张图", ["/work/ready.png"]);
});

it.each(["switch", "unmount"])("keeps a late pasted image with its original draft after %s", async (action) => {
  let finish!: (path: string) => void;
  fake.save.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  const view = render(<ComposerCard {...props} draftKey="paste-A" />);
  fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => new File(["image"], "pasted.png", { type: "image/png" }) }] } });
  await waitFor(() => expect(fake.save).toHaveBeenCalledOnce());
  if (action === "switch") view.rerender(<ComposerCard {...props} draftKey="paste-B" />);
  else view.unmount();
  await act(async () => finish("/work/pasted-a.png"));
  expect(screen.queryByText("pasted-a.png")).toBeNull();
  expect(JSON.parse(localStorage.getItem("miniq.draft.paste-A.attachments")!)).toEqual(["/work/pasted-a.png"]);
  expect(localStorage.getItem("miniq.draft.paste-B.attachments")).toBeNull();
});

it("claims an image paste while sending instead of letting the WebView insert it", async () => {
  const onSend = vi.fn(() => new Promise<boolean>(() => {}));
  render(<ComposerCard {...props} draftKey="paste-sending" onSend={onSend} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "发送中" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(onSend).toHaveBeenCalledOnce();
  const image = new File(["image"], "late.png", { type: "image/png" });
  expect(fireEvent.paste(input, { clipboardData: { items: [], files: [image] } })).toBe(false);
  expect(fake.save).not.toHaveBeenCalled();
});

it("attaches a document copied from the file manager", async () => {
  fake.save.mockResolvedValueOnce("/cache/pasted-files/1700000000-42/报告.pdf");
  render(<ComposerCard {...props} draftKey="paste-pdf" />);
  const pdf = new File(["pdf"], "报告.pdf", { type: "application/pdf" });
  expect(fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [], files: [pdf] } })).toBe(false);
  expect(await screen.findByText("报告.pdf")).toBeTruthy();
  expect(fake.save).toHaveBeenCalledExactlyOnceWith(pdf);
});

it("saves an image pasted with an empty MIME type as its inferred format", async () => {
  fake.save.mockResolvedValueOnce("/work/untyped.png");
  render(<ComposerCard {...props} draftKey="paste-untyped" />);
  const file = new File(["image"], "untyped.png");
  fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ kind: "file", type: "", getAsFile: () => file }] } });
  expect(await screen.findByText("untyped.png")).toBeTruthy();
  expect(fake.save.mock.calls[0][0].type).toBe("image/png");
});
