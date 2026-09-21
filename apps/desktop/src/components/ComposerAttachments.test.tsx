// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";

const fake = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../localFiles", () => ({ savePastedImage: fake.save, readImagePreview: vi.fn().mockRejectedValue(new Error("preview unavailable")) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: fake.open }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent: async () => () => {} }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

const props = { busy: false, placeholder: "消息", onSend: vi.fn() };
it("saves late file picker results to the originating draft without changing the new session", async () => {
  let finish!: (paths: string[]) => void;
  fake.open.mockImplementationOnce(() => new Promise<string[]>((resolve) => { finish = resolve; }));
  localStorage.setItem("miniq.draft.A.attachments", JSON.stringify(["/work/original-a.pdf"]));
  localStorage.setItem("miniq.draft.B.attachments", JSON.stringify(["/work/original-b.pdf"]));
  const view = render(<ComposerCard {...props} draftKey="A" />);
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
