import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("background browser host", () => {
  it("keeps hidden WebViews at a stable automation viewport", () => {
    const css = readFileSync(new URL("./review.css", import.meta.url), "utf8");
    const rule = css.match(/\.background-browser-host\s*\{([^}]*)\}/)?.[1];
    const panelRule = css.match(
      /\.background-browser-host \.browser-panel\s*\{([^}]*)\}/,
    )?.[1];

    expect(rule).toContain("width: 1280px");
    expect(rule).toContain("height: 720px");
    expect(panelRule).toContain("width: 100%");
    expect(panelRule).toContain("height: 100%");
    expect(panelRule).not.toContain("1px");
  });
});