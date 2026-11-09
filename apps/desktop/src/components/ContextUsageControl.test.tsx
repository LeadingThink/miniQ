// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { ContextUsage } from "../contextUsage";
import { ContextUsageControl } from "./ContextUsageControl";
import { useOpenDialog } from "../hooks/useOpenDialog";

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); }) });
});

type ContextUsageState = {
  usage: ContextUsage | null;
  loading: boolean;
  error: string | null;
};

const mock = vi.hoisted(() => ({
  refresh: vi.fn().mockResolvedValue(undefined),
  state: {
    usage: {
      estimatedTokens: 1_200,
      contextWindowTokens: 8_000,
      autoCompactTokens: 6_400,
      percentUsed: 15,
      lastRequestTokens: 1_100,
    } as ContextUsage,
    loading: false,
    error: null as string | null,
  } as ContextUsageState,
}));

vi.mock("../hooks/useContextUsage", () => ({
  useContextUsage: () => ({ ...mock.state, refresh: mock.refresh }),
}));

afterEach(() => {
  cleanup();
  mock.refresh.mockClear();
  mock.state = {
    usage: {
      estimatedTokens: 1_200,
      contextWindowTokens: 8_000,
      autoCompactTokens: 6_400,
      percentUsed: 15,
      lastRequestTokens: 1_100,
    },
    loading: false,
    error: null,
  };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function renderControl() {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  return render(<ContextUsageControl client={{} as RpcClient} sessionId="session-a" />);
}

it("opens an accessible popover, refreshes on open, and closes with its close button", () => {
  renderControl();
  const trigger = screen.getByRole("button", { name: "上下文用量" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "上下文用量" });
  expect(dialog.tagName).toBe("DIALOG");
  expect(dialog.parentElement).toBe(document.body);
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
  expect(mock.refresh).toHaveBeenCalledOnce();
  expect(within(dialog).getByText("系统提示词")).toBeTruthy();
  expect(within(dialog).getByText("工具及子智能体")).toBeTruthy();
  expect(within(dialog).getByText("对话消息")).toBeTruthy();
  expect(within(dialog).getByText("连接器及 MCP")).toBeTruthy();
  expect(within(dialog).getByText("技能")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭上下文用量" }));
  expect(screen.queryByRole("dialog", { name: "上下文用量" })).toBeNull();
});

it("signals embedded browser suspension while the top-layer dialog is open", async () => {
  function BrowserVisibilityProbe() {
    return <output data-testid="browser-suspended">{String(useOpenDialog())}</output>;
  }
  renderControl();
  render(<BrowserVisibilityProbe />);
  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  await vi.waitFor(() => expect(screen.getByTestId("browser-suspended").textContent).toBe("true"));
  fireEvent.click(screen.getByRole("button", { name: "关闭上下文用量" }));
  await vi.waitFor(() => expect(screen.getByTestId("browser-suspended").textContent).toBe("false"));
});

it("distinguishes unknown capacity from a known zero percent usage", () => {
  mock.state = { ...mock.state, usage: { ...mock.state.usage!, estimatedTokens: 0, contextWindowTokens: 8_000, percentUsed: 0 } };
  renderControl();
  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  expect(screen.getByRole("dialog", { name: "上下文用量" }).textContent).toContain("0%");

  cleanup();
  mock.state = { ...mock.state, usage: { ...mock.state.usage!, contextWindowTokens: null, percentUsed: null } };
  renderControl();
  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  expect(screen.getByRole("dialog", { name: "上下文用量" }).textContent).not.toContain("0%");
});

it("shows the error and retries from the popover", () => {
  mock.state = { usage: null, loading: false, error: "daemon unavailable" };
  renderControl();
  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  const dialog = screen.getByRole("dialog", { name: "上下文用量" });
  expect(within(dialog).getByRole("alert").textContent).toContain("daemon unavailable");
  fireEvent.click(within(dialog).getByRole("button", { name: /重试|刷新/ }));
  expect(mock.refresh).toHaveBeenCalledTimes(2);
});

it("closes on Escape and returns keyboard focus to the trigger", () => {
  renderControl();
  const trigger = screen.getByRole("button", { name: "上下文用量" });
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "上下文用量" }), { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "上下文用量" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("dismisses backdrop clicks but keeps content and interior whitespace open", () => {
  renderControl();
  const trigger = screen.getByRole("button", { name: "上下文用量" });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "上下文用量" });
  vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
    left: 100, top: 100, right: 440, bottom: 600, width: 340, height: 500,
    x: 100, y: 100, toJSON: () => ({}),
  });
  fireEvent.click(within(dialog).getByText("系统提示词"));
  expect(screen.getByRole("dialog")).toBe(dialog);
  fireEvent.click(dialog, { clientX: 120, clientY: 120 });
  expect(screen.getByRole("dialog")).toBe(dialog);
  fireEvent.click(dialog, { clientX: 50, clientY: 120 });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("uses the actual compaction threshold for warnings rather than the capacity percentage", () => {
  mock.state.usage = { ...mock.state.usage!, estimatedTokens: 6_500, percentUsed: 81.25 };
  renderControl();
  const trigger = screen.getByRole("button", { name: "上下文用量" });
  expect(trigger.classList.contains("is-warning")).toBe(true);
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog").textContent).toContain("基础估算已达到自动压缩阈值");
});
