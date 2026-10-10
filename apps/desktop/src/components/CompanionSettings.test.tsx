// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompanionSettings } from "./CompanionSettings";
import { setCompanionMode } from "../companionPrefs";
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../companionPrefs", () => ({
  DEFAULT_COMPANION_PREFS: { mode: "hidden" },
  readCompanionPrefs: vi.fn(async () => ({ mode: "hidden" })),
  listenCompanionPrefs: vi.fn(async () => () => {}),
  setCompanionMode: vi.fn(async (mode) => ({ mode })),
}));
afterEach(cleanup);
it("stays hidden until the user explicitly enables a mode and changes only companion preferences", async () => {
  render(<CompanionSettings />);
  const select = screen.getByLabelText("桌面伙伴外观") as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  expect(select.value).toBe("hidden");
  expect(setCompanionMode).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: "pet" } });
  await waitFor(() => expect(select.value).toBe("pet"));
  expect(setCompanionMode).toHaveBeenCalledExactlyOnceWith("pet");
});
