// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { getKeepAwake, setKeepAwake, useKeepAwake } from "./keepAwake";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => false }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("persists the preference and notifies an active hook", () => {
  const hook = renderHook(() => useKeepAwake(true));
  expect(hook.result.current).toBe(false);
  act(() => setKeepAwake(true));
  expect(getKeepAwake()).toBe(true);
  expect(hook.result.current).toBe(true);
});

it("defaults to disabled when there is no stored preference", () => {
  expect(getKeepAwake()).toBe(false);
});
