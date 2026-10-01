// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { ComposerCard } from "./Composer";
import { STARTER_PROMPTS, StarterPrompts } from "./StarterPrompts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("explains the draft-first workflow and offers office task examples", () => {
  render(<StarterPrompts onSelect={vi.fn()} />);

  expect(screen.getByRole("heading", { name: "先选一个示例，再编辑任务" })).toBeTruthy();
  expect(screen.getByText("示例只会填入草稿。补充你的要求，确认后再发送。")).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(STARTER_PROMPTS.length);
  expect(screen.getByRole("button", { name: /分析一份表格/ })).toBeTruthy();
});

it("returns exactly the selected example", () => {
  const onSelect = vi.fn();
  render(<StarterPrompts onSelect={onSelect} />);

  fireEvent.click(screen.getByRole("button", { name: /提取 PDF 要点/ }));

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ id: "pdf-notes", prompt: expect.stringContaining("交付物") }),
  );
});

it.each(STARTER_PROMPTS)("selecting $title fills an editable draft without sending", (prompt) => {
  const onSend = vi.fn(async () => true);
  function StartTask() {
    const [draftRequest, setDraftRequest] = useState<{ id: number; content: string }>();
    return (
      <>
        <ComposerCard
          busy={false}
          placeholder="任务草稿"
          draftRequest={draftRequest}
          onSend={onSend}
        />
        <StarterPrompts onSelect={(item) => setDraftRequest({ id: 1, content: item.prompt })} />
      </>
    );
  }
  render(<StartTask />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "原有草稿" } });
  const button = screen.getByRole<HTMLButtonElement>("button", { name: new RegExp(prompt.title) });
  expect(button.type).toBe("button");
  button.focus();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  expect(input.value).toBe(prompt.prompt);
  expect(prompt.prompt).toContain("目标：");
  expect(prompt.prompt).toContain("输入：");
  expect(prompt.prompt).toContain("交付物：");
  fireEvent.change(input, { target: { value: `${input.value}请控制在一页以内` } });
  expect(input.value).toContain("请控制在一页以内");
  expect(onSend).not.toHaveBeenCalled();
});
