import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The wallpaper header uses backdrop-filter, which creates a stacking context.
// Its ⋯ menu then can only rise above the timeline if the header itself does.
it("keeps the wallpaper conversation header above the timeline", () => {
  const css = readFileSync(new URL("./living-background.css", import.meta.url), "utf8");
  const rule = css.match(/:root\[data-background\] \.conversation-context \{([^}]*)\}/)?.[1] ?? "";
  expect(rule).toMatch(/position:\s*relative/);
  const z = Number(rule.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
  // Above the conversation navigation rail (20) inside the timeline.
  expect(z).toBeGreaterThan(20);
});

it("keeps the expanded execution plan above wallpaper message surfaces", () => {
  const css = readFileSync(new URL("./living-background.css", import.meta.url), "utf8");
  const rule = css.match(/:root\[data-background\] \.execution-status-bar \{([^}]*)\}/)?.[1] ?? "";
  expect(rule).toMatch(/position:\s*relative/);
  const z = Number(rule.match(/z-index:\s*(\d+)/)?.[1] ?? 0);
  // The execution bar owns the backdrop-filter stacking context. Its plan
  // popover must rise above later assistant bubbles in the timeline.
  expect(z).toBeGreaterThan(20);
});
