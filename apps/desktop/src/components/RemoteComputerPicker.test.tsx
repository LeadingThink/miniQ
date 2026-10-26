// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import {
  RemoteDeviceBarContext,
  type RemoteDeviceBar,
} from "../remoteDeviceBar";
import { RemoteConnectionStatus } from "./RemoteConnectionStatus";

vi.mock("../desktopHost", () => ({ useDesktopHost: () => null }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const first = { id: "desktop-a", name: "电脑A", online: true };
const second = { id: "desktop-b", name: "电脑B", online: false };
function setup(overrides: Partial<RemoteDeviceBar> = {}) {
  const bar: RemoteDeviceBar = {
    name: first.name,
    online: true,
    selected: first,
    devices: [first, second],
    loading: false,
    error: null,
    onSelect: vi.fn(),
    onRefresh: vi.fn(),
    onSwitch: vi.fn(),
    ...overrides,
  };
  const app = {
    client: { mode: "remote" },
    catalog: {},
    connection: { connected: true },
    review: { data: { files: [] } },
    feed: { messages: [] },
  } as unknown as MiniqAppController;
  render(
    <RemoteDeviceBarContext.Provider value={bar}>
      <RemoteConnectionStatus app={app} />
    </RemoteDeviceBarContext.Provider>,
  );
  const trigger = screen.getByRole("button", {
    name: "切换连接的电脑，当前：电脑A",
  });
  fireEvent.click(trigger);
  return { bar, trigger };
}

it("opens computers directly from the header and selects an offline computer without an intermediate page", () => {
  const { bar, trigger } = setup();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(
    screen.getByRole("dialog", { name: "切换连接的电脑" }).parentElement,
  ).toBe(document.body);
  expect(screen.queryByRole("dialog", { name: "会话与连接信息" })).toBeNull();
  expect(
    screen
      .getByRole("button", { name: /电脑A\s*在线/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /电脑B.*离线/ }));
  expect(bar.onSelect).toHaveBeenCalledExactlyOnceWith(second);
  expect(bar.onSwitch).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("can refresh failed discovery while preserving the current computer and closing with Escape", () => {
  const { bar, trigger } = setup({
    devices: [],
    error: "电脑列表连接已断开，正在重试…",
  });
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /电脑A.*状态待确认/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新电脑列表" }));
  expect(bar.onRefresh).toHaveBeenCalledOnce();
  expect(bar.onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("keeps the dropdown focused on choosing a computer", () => {
  setup();
  expect(screen.getByRole("heading", { name: "切换电脑" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "刷新电脑列表" }).textContent).toBe("");
  expect(screen.queryByText(first.id)).toBeNull();
  expect(screen.queryByText(second.id)).toBeNull();
  expect(screen.queryByText("当前选择")).toBeNull();
  expect(screen.queryByText(/选择使用这个 Key/)).toBeNull();
  expect(screen.queryByRole("button", { name: "查看会话与连接详情" })).toBeNull();
});
