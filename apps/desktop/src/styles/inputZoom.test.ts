import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps touch-screen text fields at 16px or more so iOS does not zoom on focus", () => {
  const css = readFileSync(new URL("./base.css", import.meta.url), "utf8");
  const block = css.match(/@media \(pointer: coarse\) \{\s*(input[^{]*)\{([^}]*)\}/);
  expect(block).not.toBeNull();
  const [, selectors, rule] = block!;
  for (const selector of ["input", "textarea", "select", "[contenteditable=\"true\"]"]) {
    expect(selectors).toContain(selector);
  }
  expect(rule).toContain("font-size: max(16px, 1em) !important");
});
