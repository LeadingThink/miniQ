// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ZaiwenSite } from "./ZaiwenSite";

vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../browserEvents", () => ({ listenBrowserEvent: () => () => {} }));
vi.mock("../hooks/useBrowserPanel", () => ({ useBrowserPanel: () => ({
  viewId: "zaiwen-site", loading: false, loadError: null, error: null, setError: vi.fn(),
}) }));
afterEach(cleanup);

it("keeps account setup out of the main-site page and reports readiness", () => {
  const ready = vi.fn();
  render(<ZaiwenSite active onReadyChange={ready} />);
  expect(screen.getByRole("main", { name: "在问主站" })).toBeTruthy();
  expect(ready).toHaveBeenCalledWith(true);
  expect(screen.queryByRole("button", { name: "选择在问 API Key" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
