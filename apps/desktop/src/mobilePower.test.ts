import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ enabled: true, getState: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.enabled },
  registerPlugin: () => ({ getState: native.getState }),
}));
import { getState } from "./mobilePower";

afterEach(() => { native.enabled = true; native.getState.mockReset(); });

it("reads the native power saver state", async () => {
  native.getState.mockResolvedValue({ lowPower: true });
  expect(await getState()).toEqual({ lowPower: true });
  native.getState.mockResolvedValue({ lowPower: false });
  expect(await getState()).toEqual({ lowPower: false });
});

it("does not invoke the native plugin on the web", async () => {
  native.enabled = false;
  expect(await getState()).toBeNull();
  expect(native.getState).not.toHaveBeenCalled();
});

it.each([null, {}, { lowPower: "false" }, { lowPower: 0 }])("keeps malformed power results unknown: %j", async (result) => {
  native.getState.mockResolvedValue(result);
  expect(await getState()).toBeNull();
});

it("keeps plugin failures unknown", async () => {
  native.getState.mockRejectedValue(new Error("unavailable"));
  expect(await getState()).toBeNull();
});
