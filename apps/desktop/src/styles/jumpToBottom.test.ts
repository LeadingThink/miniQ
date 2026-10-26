import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const conversationCss = readFileSync(new URL("./conversation.css", import.meta.url), "utf8");
const baseCss = readFileSync(new URL("./base.css", import.meta.url), "utf8");

function rule(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("jump to bottom button", () => {
  it("centres without a transform so the global press scale cannot shift it sideways", () => {
    expect(rule(baseCss, "button:active:not(:disabled)")).toContain("transform: scale(");
    const button = rule(conversationCss, ".jump-to-bottom");
    expect(button).not.toContain("transform");
    expect(button).toMatch(/left: 0;[\s\S]*right: 0;[\s\S]*margin-inline: auto;/);
  });
});
