// @vitest-environment jsdom
import { fireEvent, render, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserPanel } from "./BrowserPanel";

const { load } = vi.hoisted(() => ({ load: vi.fn(async () => {}) }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../hooks/useBrowserPanel", () => ({ useBrowserPanel: () => ({
  address: "https://next.test/", activeUrl: "https://first.test/", pending: false,
  loading: false, error: null, editing: { current: false }, load,
  setAddress: vi.fn(), setError: vi.fn(), action: vi.fn(),
}) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("explicitly navigates an automation-owned tab when the user submits a new address", () => {
  const onNavigate = vi.fn();
  const view = render(<BrowserPanel url="https://first.test/" browserSessionId="browser-owned" onNavigate={onNavigate} onClose={vi.fn()} />);
  fireEvent.submit(view.getByLabelText("网址").closest("form")!);
  expect(load).toHaveBeenCalledExactlyOnceWith("https://next.test/");
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("https://next.test/");
});

it("explicitly navigates a manual tab without relying on URL metadata effects", () => {
  const onNavigate = vi.fn();
  const view = render(<BrowserPanel url="https://first.test/" onNavigate={onNavigate} onClose={vi.fn()} />);
  fireEvent.submit(view.getByLabelText("网址").closest("form")!);
  expect(load).toHaveBeenCalledExactlyOnceWith("https://next.test/");
  expect(onNavigate).toHaveBeenCalledExactlyOnceWith("https://next.test/");
});
