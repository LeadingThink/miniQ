import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pickerCss = readFileSync(new URL("./theme-picker.css", import.meta.url), "utf8");
const shellCss = readFileSync(new URL("./shell.css", import.meta.url), "utf8");

function rule(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("appearance library tabs", () => {
  it("pins flush against the settings header by cancelling the scroll padding", () => {
    const scroll = rule(shellCss, ".settings-content-scroll");
    expect(scroll).toContain("--settings-scroll-pad-top:");
    expect(scroll).toContain("padding: var(--settings-scroll-pad-top) var(--settings-scroll-pad-inline)");
    const sticky = rule(pickerCss, ".appearance-library-sticky");
    expect(sticky).toContain("position: sticky");
    expect(sticky).toContain("top: calc(-1 * var(--settings-scroll-pad-top))");
    expect(sticky).toMatch(/background:/);
  });

  it("keeps a single sticky layer instead of also pinning the inner tablist", () => {
    expect(rule(pickerCss, ".appearance-library-tabs")).not.toContain("position: sticky");
  });
});

describe("appearance section dividers", () => {
  it("uses the next section border as the only divider below font size", () => {
    const fontSizeRow = rule(pickerCss, ".settings-panel .font-size-row,\n.font-size-row");
    expect(fontSizeRow).not.toContain("border-bottom");

    const sectionBorders = rule(
      pickerCss,
      ".appearance-mode-row,\n.theme-library-controls,\n.font-scale-control",
    );
    expect(sectionBorders).toContain("border-top: 1px solid var(--hairline)");
  });

  it("separates the theme heading from its divider using the standard row inset", () => {
    const controls = rule(pickerCss, ".theme-library-controls");
    expect(controls).toContain("padding-top: 14px");

    const fontSizeRow = rule(pickerCss, ".settings-panel .font-size-row,\n.font-size-row");
    expect(fontSizeRow).toContain("padding: 14px 0");

    const layout = rule(pickerCss, ".appearance-settings,\n.theme-library");
    expect(layout).toContain("gap: 24px");
  });
});
