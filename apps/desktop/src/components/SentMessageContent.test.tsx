// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SentMessageContent } from "./SentMessageContent";

afterEach(cleanup);

it("shows a long paste as a dialog trigger and keeps surrounding text separate", () => {
  const paste = "正文".repeat(600);
  const { container } = render(
    <SentMessageContent content={`背景说明\n${paste}\n请简要概况该文本内容。`} />,
  );

  const texts = [...container.querySelectorAll(".sent-message-text")];
  expect(texts.map((node) => node.textContent)).toEqual(["请简要概况该文本内容。"]);
  const trigger = screen.getByRole("button", { name: "查看粘贴内容 1205 字" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");

  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog");
  expect((within(dialog).getByLabelText("完整文本") as HTMLTextAreaElement).value).toBe(`背景说明\n${paste}`);
  expect(within(dialog).getByText("1205 字")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "保存修改" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("uses persisted paste metadata for a short sent paste", () => {
  const pasted = "这是发送后仍需收起的短文本。";
  const { container } = render(
    <SentMessageContent
      content={`${pasted}\n请总结`}
      pastedText={{
        content: "[粘贴内容 14 字]\n请总结",
        pastes: [{ placeholder: "[粘贴内容 14 字]", text: pasted }],
      }}
    />,
  );

  expect(container.textContent).not.toContain(pasted);
  expect(container.textContent).toContain("请总结");
  fireEvent.click(screen.getByRole("button", { name: "查看粘贴内容 14 字" }));
  expect((screen.getByLabelText("完整文本") as HTMLTextAreaElement).value).toBe(pasted);
});

it("renders an ordinary message as one standalone text node", () => {
  const { container } = render(<SentMessageContent content="普通问题" />);
  expect(container.querySelectorAll(".sent-message-text")).toHaveLength(1);
  expect(container.querySelector(".sent-paste-chip")).toBeNull();
});