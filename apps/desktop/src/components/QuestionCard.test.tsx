// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Question } from "../types";
import { QuestionCard } from "./QuestionCard";

const question: Question = {
  id: "video-question",
  sessionId: "session-a",
  toolCallId: "tool-a",
  prompt: "**现场采集 / 数据中台视频素材怎么处理？**\n\n1) EgoBand实拍\\_实时3D手部重建.mp4\n2) RoboRDA\\_遥操作演示.mp4\n3) 多模态数据样例\\_可视化界面.mp4 / hub\\_demo.mp4\n\n没有更新素材就先使用现有素材。&#x20;可以补充路径。",
  options: ["用现有最佳素材直接做完整增强版", "我马上补充更新视频路径", "现场用现有，中台视频另给"],
  optionDescriptions: { "现场用现有，中台视频另给": "保留 **现场采集**；更新 `hub_demo.mp4`。" },
  multiSelect: false,
  createdAt: "2026-09-09T03:08:48Z",
};

afterEach(() => { cleanup(); vi.useRealTimers(); });
const confirm = () => screen.getByRole("button", { name: "确认回答" });

describe("QuestionCard", () => {
  it("renders the video prompt as Markdown with readable lists and decoded entities", () => {
    const { container } = render(<QuestionCard question={question} onResolve={vi.fn()} />);
    expect(container.querySelectorAll(".question-prompt ol li")).toHaveLength(3);
    expect(container.querySelector(".question-prompt strong")?.textContent).toBe("现场采集 / 数据中台视频素材怎么处理？");
    expect(container.textContent).toContain("EgoBand实拍_实时3D手部重建.mp4");
    expect(container.textContent).not.toContain("\\_");
    expect(container.textContent).not.toContain("&#x20;");
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect((confirm() as HTMLButtonElement).disabled).toBe(true);
  });

  it("preserves the full source question without inventing or removing choices", () => {
    const prompt = `${question.prompt}\n\" 正式问题：\n素材怎么处理？\n\" CLEAN:\n素材怎么处理？\n\" 请选择。`;
    render(<QuestionCard question={{ ...question, prompt, options: [] }} onResolve={vi.fn()} />);
    expect(screen.getByRole("region", { name: "问题详情" }).textContent).toContain('" CLEAN:');
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByRole("textbox", { name: "你的回答" })).toBeTruthy();
  });

  it("uses normal file and web navigation for prompt links", () => {
    const onOpenFile = vi.fn(), onOpenUrl = vi.fn();
    render(<QuestionCard question={{ ...question, prompt: "[素材](./hub_demo.mp4) / [来源](https://example.test/source)" }}
      workspacePath="/work/project" onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} onResolve={vi.fn()} />);
    fireEvent.click(screen.getByRole("link", { name: "素材" }));
    expect(onOpenFile).toHaveBeenCalledWith({ path: "/work/project/hub_demo.mp4", line: null, column: null });
    fireEvent.click(screen.getByRole("link", { name: "来源" }));
    expect(onOpenUrl).toHaveBeenCalledWith("https://example.test/source");
  });

  it("renders descriptions safely without nested links or executable HTML", () => {
    const option = "**现有** &amp; `hub_demo.mp4` [网页](https://example.test)";
    const { container } = render(<QuestionCard question={{ ...question, prompt: "<script>alert(1)</script>", options: [option], optionDescriptions: { [option]: "<img src=x onerror=alert(1)>保留说明" } }} onResolve={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "现有 & hub_demo.mp4 网页" })).toBeTruthy();
    expect(container.querySelector(".question-option strong")?.textContent).toBe("现有");
    expect(container.querySelectorAll("script, img, .question-option a, .question-option button")).toHaveLength(0);
    expect(container.textContent).toContain("保留说明");
  });

  it("waits for explicit confirmation and preserves the selected label", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard question={question} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("radio", { name: question.options[0] }));
    expect(onResolve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: question.options[2] }));
    fireEvent.click(confirm());
    await waitFor(() => expect(onResolve).toHaveBeenCalledExactlyOnceWith(question.id, question.options[2]));
    expect(screen.getByRole("status").textContent).toBe("回答已发送");
  });

  it("combines multiple selections with complete multiline supplemental paths", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard question={{ ...question, multiSelect: true }} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("checkbox", { name: question.options[0] }));
    fireEvent.click(screen.getByRole("checkbox", { name: question.options[1] }));
    fireEvent.click(screen.getByRole("checkbox", { name: question.options[0] }));
    const paths = "/work/新现场视频.mov\n/work/hub_demo.mp4";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: paths } });
    fireEvent.click(confirm());
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(question.id, `${question.options[1]}\n${paths}`));
  });

  it("allows clearing a choice and sending only a free answer", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<QuestionCard question={question} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("radio", { name: question.options[0] }));
    fireEvent.click(screen.getByRole("button", { name: "清除选择" }));
    expect(screen.getAllByRole("radio").every((input) => !(input as HTMLInputElement).checked)).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "只补新素材" } });
    fireEvent.click(confirm());
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith(question.id, "只补新素材"));
  });

  it("prevents duplicate submissions while awaiting acknowledgement and after success", async () => {
    let finish!: () => void;
    const onResolve = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<QuestionCard question={{ ...question, options: [] }} onResolve={onResolve} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "现有素材" } });
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.submit(screen.getByRole("form"));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => finish());
    fireEvent.submit(screen.getByRole("form"));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("keeps the answer and exposes a retry when sending fails", async () => {
    const onResolve = vi.fn().mockRejectedValueOnce(new Error("连接断开")).mockResolvedValue(undefined);
    render(<QuestionCard question={question} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("radio", { name: question.options[0] }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "不要占位" } });
    fireEvent.click(confirm());
    expect((await screen.findByRole("alert")).textContent).toContain("连接断开");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("不要占位");
    fireEvent.click(confirm());
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
    expect(onResolve.mock.calls[1]).toEqual(onResolve.mock.calls[0]);
  });

  it("does not send on plain Enter or during Chinese composition", () => {
    const onResolve = vi.fn();
    render(<QuestionCard question={question} onResolve={onResolve} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "新素材" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("resets drafts and selection when a different question is displayed", () => {
    const { rerender } = render(<QuestionCard question={question} onResolve={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: question.options[0] }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "旧路径" } });
    rerender(<QuestionCard question={{ ...question, id: "question-b" }} onResolve={vi.fn()} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect((confirm() as HTMLButtonElement).disabled).toBe(true);
  });

  it("retains the existing automatic continuation deadline without submitting from the UI", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(question.createdAt));
    const onResolve = vi.fn();
    render(<QuestionCard question={{ ...question, autoContinueAfterSeconds: 180, defaultAnswer: question.options[0] }} onResolve={onResolve} />);
    expect(screen.getByText(/完全访问模式/).textContent).toContain("3:00");
    act(() => vi.advanceTimersByTime(180_000));
    expect(screen.getByText(/完全访问模式/).textContent).toContain("0:00");
    expect(onResolve).not.toHaveBeenCalled();
  });
});
