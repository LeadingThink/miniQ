// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WindowControls } from "./WindowControls";

const window = vi.hoisted(() => ({
  isMaximized: vi.fn(async () => false), onResized: vi.fn(async (_handler: () => void): Promise<() => void> => vi.fn(() => {})),
  minimize: vi.fn(async () => {}), toggleMaximize: vi.fn(async () => {}), close: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => window }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("uses native controls and follows the actual maximized state", async () => {
  render(<WindowControls onError={vi.fn()} />);
  await waitFor(() => expect(window.onResized).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "最小化" }));
  fireEvent.click(screen.getByRole("button", { name: "最大化" }));
  window.isMaximized.mockResolvedValueOnce(true);
  await act(async () => window.onResized.mock.calls[0][0]());
  expect(screen.getByRole("button", { name: "还原窗口" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
  expect(window.minimize).toHaveBeenCalledOnce();
  expect(window.toggleMaximize).toHaveBeenCalledOnce();
  expect(window.close).toHaveBeenCalledOnce();
});

it("cleans up listeners that resolve after unmount", async () => {
  const off = vi.fn();
  let resolve!: (value: () => void) => void;
  window.onResized.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(<WindowControls onError={vi.fn()} />);
  view.unmount();
  await act(async () => resolve(off));
  expect(off).toHaveBeenCalledOnce();
});
