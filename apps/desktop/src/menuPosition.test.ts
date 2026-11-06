import { expect, it } from "vitest";
import { menuPosition } from "./menuPosition";

it("keeps composer menus inside narrow viewports", () => {
  const rect = menuPosition(
    { left: 240, top: 620, bottom: 648 },
    { width: 280, height: 240 },
    { width: 320, height: 740 },
  );
  expect(rect.left).toBe(32);
  expect(rect.top).toBe(372);
  expect(rect.left + 280).toBeLessThanOrEqual(312);
});
it("opens below top controls and bounds height with the on-screen keyboard", () => {
  const rect = menuPosition(
    { left: 0, top: 46, bottom: 74 },
    { width: 280, height: 300 },
    { width: 320, height: 250 },
  );
  expect(rect).toEqual({ left: 8, top: 82, maxHeight: 160 });
});
it("supports a larger viewport gap for wide anchored panels", () => {
  const rect = menuPosition(
    { left: 760, top: 40, bottom: 72 },
    { width: 360, height: 300 },
    { width: 1000, height: 700 },
    16,
  );
  expect(rect.left).toBe(624);
  expect(rect.left + 360).toBe(984);
});

it("flips a form picker near the window bottom upward so it stays inside the window", () => {
  const rect = menuPosition(
    { left: 380, top: 606, bottom: 640 },
    { width: 160, height: 160 },
    { width: 1077, height: 716 },
  );
  expect(rect.top).toBe(438);
  expect(rect.top + 160).toBeLessThanOrEqual(716 - 8);
  expect(rect.maxHeight).toBe(590);
});

it("keeps menus inside the visible viewport safe area", () => {
  const rect = menuPosition(
    { left: 40, top: 220, bottom: 252 },
    { width: 320, height: 300 },
    { width: 390, height: 740, top: 48, bottom: 400 },
  );
  expect(rect.top).toBe(56);
  expect(rect.maxHeight).toBe(156);
  expect(rect.left).toBe(40);
});
