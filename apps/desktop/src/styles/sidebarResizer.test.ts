import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./base.css", import.meta.url), "utf8");

function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
}

describe("sidebar resizer grip", () => {
  it("never shows the grip, including on hover", () => {
    expect(rule(".sidebar > .workbench-resizer::before")).toMatch(/display:\s*none;/);
    expect(css).not.toMatch(/\.sidebar > \.workbench-resizer:[^{]*::before/);
  });

  it("keeps the hit area visible so hovering can reveal it", () => {
    const base = rule(".sidebar > .workbench-resizer");
    expect(base).toContain("width:12px");
    expect(base).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity/);
  });
});
