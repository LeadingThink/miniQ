// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage } from "../types";
import { QueueBar } from "./QueueBar";

afterEach(cleanup);
const item: QueuedMessage = {
  id: "q1",
  sessionId: "s1",
  content: "原来的消息",
  position: 1,
  createdAt: "2026-09-10",
  attachments: [{ name: "说明.pdf", path: "/workspace/说明.pdf" }],
};
const callbacks = () => ({
  onUpdate: vi.fn(async () => {}),
  onRemove: vi.fn(async () => {}),
  onSteer: vi.fn(async () => {}),
});
function edit(content: string) {
  fireEvent.click(screen.getByRole("button", { name: "编辑第 1 条排队消息" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: content } });
}

describe("pending queue editing", () => {
  it("edits in place, preserves attachments, and saves only once while pending", async () => {
    let finish!: () => void;
    const props = callbacks();
    props.onUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<QueueBar queue={[item]} {...props} />);
    edit("修改后的多行\n完整消息");
    expect(screen.getByText("保留附件：说明.pdf")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      ctrlKey: true,
    });
    fireEvent.submit(screen.getByRole("form"));
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith(item, "修改后的多行\n完整消息");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "取消" }).disabled,
    ).toBe(true);
    await act(async () => finish());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(props.onSteer).not.toHaveBeenCalled();
  });

  it("retains failed drafts for retry without leaking an error to another session", async () => {
    const props = callbacks();
    props.onUpdate.mockRejectedValueOnce(new Error("连接已断开"));
    const view = render(<QueueBar key="s1" queue={[item]} {...props} />);
    edit("不要丢失我");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
      "不要丢失我",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    edit("另一个草稿");
    view.rerender(<QueueBar key="s2" queue={[]} {...props} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the draft when the message starts while being edited", () => {
    const props = callbacks();
    const view = render(<QueueBar queue={[item]} {...props} />);
    edit("任务已经开始也要保留");
    view.rerender(<QueueBar queue={[]} {...props} />);
    expect(screen.getByRole("status").textContent).toContain("已开始执行");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
      "任务已经开始也要保留",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "复制编辑内容" })).toBeTruthy();
  });

  it("detects a remote edit and requires loading the new baseline explicitly", async () => {
    const props = callbacks();
    const view = render(<QueueBar queue={[item]} {...props} />);
    edit("本地草稿");
    const remote = { ...item, content: "手机修改了" };
    view.rerender(<QueueBar queue={[remote]} {...props} />);
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
      "本地草稿",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "载入最新内容" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "合并后的消息" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(props.onUpdate).toHaveBeenCalledWith(remote, "合并后的消息"),
    );
  });

  it("supports multiline and IME entry; Escape cancels without a mutation", () => {
    const props = callbacks();
    render(<QueueBar queue={[item]} {...props} />);
    edit("中文输入");
    const editor = screen.getByRole("textbox");
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.keyDown(editor, {
      key: "Enter",
      metaKey: true,
      isComposing: true,
    });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true, keyCode: 229 });
    expect(props.onUpdate).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "编辑第 1 条排队消息" }),
    );
  });

  it("rejects blank text without attachments but allows an attachment-only update", () => {
    const props = callbacks();
    const view = render(
      <QueueBar queue={[{ ...item, attachments: [] }]} {...props} />,
    );
    edit("  \n");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled,
    ).toBe(true);
    view.unmount();
    render(<QueueBar queue={[item]} {...props} />);
    edit("");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled,
    ).toBe(false);
  });

  it("serializes steering/removal and shows action errors next to the queue", async () => {
    let fail!: (cause: Error) => void;
    const props = callbacks();
    props.onRemove.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    render(<QueueBar queue={[item]} {...props} />);
    const remove = screen.getByRole("button", { name: "移除第 1 条排队消息" });
    fireEvent.click(remove);
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "调整方向" }));
    expect(props.onRemove).toHaveBeenCalledTimes(1);
    expect(props.onSteer).not.toHaveBeenCalled();
    await act(async () => fail(new Error("消息已经移除")));
    expect(screen.getByRole("alert").textContent).toBe("消息已经移除");
  });
});
