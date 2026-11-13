// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { ContextUsage } from "../contextUsage";
import { ContextUsageControl } from "./ContextUsageControl";
import { useOpenDialog } from "../hooks/useOpenDialog";

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const originalShowPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
const originalHidePopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidePopover");
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true,
    value: vi.fn(function (this: HTMLDialogElement) { this.removeAttribute("open"); }) });
  Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true,
    value: vi.fn(function (this: HTMLElement) { this.style.display = "block"; }) });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true,
    value: vi.fn(function (this: HTMLElement) { this.style.display = "none"; }) });
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
      lastRequestActualTokens: 1_050,
      categories: [
        { id: "system", tokens: 600 },
        { id: "tools", tokens: 300 },
        { id: "conversation", tokens: 200 },
        { id: "connectors", tokens: 50 },
        { id: "skills", tokens: 50 },
      ],
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
      lastRequestActualTokens: 1_050,
      categories: [
        { id: "system", tokens: 600 },
        { id: "tools", tokens: 300 },
        { id: "conversation", tokens: 200 },
        { id: "connectors", tokens: 50 },
        { id: "skills", tokens: 50 },
      ],
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
  if (originalShowPopover) Object.defineProperty(HTMLElement.prototype, "showPopover", originalShowPopover);
  else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  if (originalHidePopover) Object.defineProperty(HTMLElement.prototype, "hidePopover", originalHidePopover);
  else Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
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
  expect(dialog.tagName).toBe("DIV");
  expect(dialog.parentElement).toBe(document.body);
  expect(dialog.getAttribute("popover")).toBe("manual");
  expect(HTMLElement.prototype.showPopover).toHaveBeenCalledOnce();
  expect(HTMLDialogElement.prototype.showModal).not.toHaveBeenCalled();
  expect(mock.refresh).toHaveBeenCalledOnce();
  expect(within(dialog).getByText("系统提示词")).toBeTruthy();
  expect(within(dialog).getByText("工具及子智能体")).toBeTruthy();
  expect(within(dialog).getByText("对话消息")).toBeTruthy();
  expect(within(dialog).getByText("连接器及 MCP")).toBeTruthy();
  expect(within(dialog).getByText("技能")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭上下文用量" }));
  expect(screen.queryByRole("dialog", { name: "上下文用量" })).toBeNull();
});

it("keeps the embedded browser visible while the information popover is open", async () => {
  function BrowserVisibilityProbe() {
    return <output data-testid="browser-suspended">{String(useOpenDialog())}</output>;
  }
  renderControl();
  render(<BrowserVisibilityProbe />);
  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  await vi.waitFor(() => expect(screen.getByTestId("browser-suspended").textContent).toBe("false"));
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

it("dismisses outside clicks but keeps content clicks open", () => {
  renderControl();
  const trigger = screen.getByRole("button", { name: "上下文用量" });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "上下文用量" });
  fireEvent.mouseDown(within(dialog).getByText("系统提示词"));
  expect(screen.getByRole("dialog")).toBe(dialog);
  fireEvent.mouseDown(document.body);
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

it("shows the estimated split per category and the provider-reported input", () => {
  renderControl();
  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  const dialog = screen.getByRole("dialog", { name: "上下文用量" });
  expect(dialog.textContent).toContain("600 tokens");
  expect(dialog.textContent).toContain("300 tokens");
  expect(dialog.textContent).toContain("模型接口实际输入");
  expect(dialog.textContent).toContain("1,050 tokens");
});

it("reports categories and actual input as unknown instead of guessing", () => {
  mock.state = {
    ...mock.state,
    usage: {
      estimatedTokens: 1_200,
      contextWindowTokens: 8_000,
      autoCompactTokens: 6_400,
      percentUsed: 15,
      lastRequestTokens: null,
      lastRequestActualTokens: null,
      categories: null,
    },
  };
  renderControl();
  fireEvent.click(screen.getByRole("button", { name: "上下文用量" }));
  const dialog = screen.getByRole("dialog", { name: "上下文用量" });
  expect(within(dialog).getAllByText("未单独统计")).toHaveLength(5);
  expect(dialog.textContent).toContain("暂无请求记录");
});
