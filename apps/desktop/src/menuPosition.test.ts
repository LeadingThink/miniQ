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
