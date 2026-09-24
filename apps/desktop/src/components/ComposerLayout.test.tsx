// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COMPOSER_KEYBOARD_HINT } from "../composerInput";
import { ComposerCard } from "./Composer";

let notifyResize!: () => void;
let textareaWidth = 500;

beforeEach(() => {
  textareaWidth = 500;
  notifyResize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notifyResize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: textareaWidth }) as DOMRect,
  );
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => 48,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("recomputes composer height when its width changes during a sidebar drag", () => {
  render(
    <ComposerCard
      busy={false}
      placeholder="消息"
      draftKey="layout"
      onSend={vi.fn()}
    />,
  );
  const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
  expect(textarea.style.height).toBe("48px");

  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    value: 176,
  });
  textareaWidth = 340;
  notifyResize();

  expect(textarea.style.height).toBe("176px");
});

it("keeps the keyboard hint beside the right-aligned send controls", () => {
  const { container } = render(
    <ComposerCard
      busy={false}
      placeholder="消息"
      draftKey="controls"
      onSend={vi.fn()}
    />,
  );
  const hint = screen.getByText(COMPOSER_KEYBOARD_HINT);
  const controls = container.querySelector(".composer-submit-buttons");
  const sendButton = screen.getByRole("button", { name: "发送消息" });
  expect(controls?.contains(hint)).toBe(true);
  expect(controls?.contains(sendButton)).toBe(true);
  expect(hint.compareDocumentPosition(sendButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("toggles goal mode and sends the next message as a goal", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  render(
    <ComposerCard
      busy={false}
      placeholder="消息"
      draftKey="goal-action"
      permissionSlot={<button type="button">替我审批</button>}
      allowGoal
      onSend={onSend}
    />,
  );

  const permission = screen.getByRole("button", { name: "替我审批" });
  const goal = screen.getByRole("button", { name: "目标" });
  expect(permission.nextElementSibling).toBe(goal);
  fireEvent.click(goal);
  expect(goal.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("目标", { selector: ".composer-goal-prefix" })).toBeTruthy();

  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
    target: { value: "整理发布说明" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

  await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith("整理发布说明", [], true));
  await vi.waitFor(() => expect(goal.getAttribute("aria-pressed")).toBe("false"));
});
