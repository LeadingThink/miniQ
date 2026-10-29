// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

it("stretches the add-server card to the full actions-row width", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(process.cwd(), "src/components/Mcp.css"), "utf8");
  document.head.append(style);
  document.body.innerHTML = `
    <div class="mcp-actions-row">
      <button>管理来源扩展包</button>
      <div class="form-card">添加服务器</div>
    </div>
  `;

  const card = getComputedStyle(document.querySelector(".form-card")!);
  expect(card.width).toBe("100%");
  expect(card.maxWidth).toBe("none");
  expect(card.boxSizing).toBe("border-box");
});