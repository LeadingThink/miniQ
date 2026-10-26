import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skillsCss = readFileSync(new URL("./Skills.css", import.meta.url), "utf8");
const settingsCss = readFileSync(new URL("../styles/interactions.css", import.meta.url), "utf8");

function rule(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("skills search layout", () => {
  it("keeps the icon and input on one row despite the settings label column layout", () => {
    expect(rule(settingsCss, ".settings-panel label")).toContain("flex-direction: column");
    const search = rule(skillsCss, ".skill-filters > .skill-search");
    expect(search).toContain("display: flex");
    expect(search).toContain("flex-direction: row");
    expect(skillsCss).not.toMatch(/^\.skill-search \{/m);
  });

  it("renders the skill count as a smaller single-line caption", () => {
    const status = rule(skillsCss, '.skill-filters [role="status"]');
    expect(status).toContain("font-size: var(--font-footnote)");
    expect(status).toContain("white-space: nowrap");
  });
});
