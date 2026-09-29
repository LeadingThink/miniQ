// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchLauncher } from "./WorkbenchLauncher";

afterEach(cleanup);

it("lists only the available entry points and runs them", () => {
  const files = vi.fn();
  const browser = vi.fn();
  const terminal = vi.fn();
  render(
    <WorkbenchLauncher
      actions={{ onOpenFiles: files, onOpenBrowser: browser, onOpenTerminal: terminal }}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "打开工作面板" });
  expect([...nav.querySelectorAll("button")].map((b) => b.dataset.entry)).toEqual([
    "files",
    "browser",
    "terminal",
  ]);
  fireEvent.click(screen.getByRole("button", { name: /文件/ }));
  fireEvent.click(screen.getByRole("button", { name: /浏览器/ }));
  fireEvent.click(screen.getByRole("button", { name: /终端/ }));
  expect(files).toHaveBeenCalledOnce();
  expect(browser).toHaveBeenCalledOnce();
  expect(terminal).toHaveBeenCalledOnce();
});

it("renders nothing without actions", () => {
  const { container } = render(<WorkbenchLauncher actions={{}} />);
  expect(container.innerHTML).toBe("");
});
