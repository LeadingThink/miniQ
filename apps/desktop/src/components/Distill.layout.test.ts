// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

it("does not turn a skill draft into the two-column settings shell", () => {
  const style=document.createElement("style");
  style.textContent=["src/styles/interactions.css","src/styles/shell.css"].map(path=>readFileSync(resolve(process.cwd(),path),"utf8")).join("\n");
  document.head.append(style);
  document.body.innerHTML='<div class="settings-overlay"><div class="settings-panel skills-panel"><h2>保存为技能</h2><div>提炼中</div><textarea>草稿</textarea><button>保存</button></div></div>';
  const panel=getComputedStyle(document.querySelector(".skills-panel")!);
  expect(panel.display).toBe("flex");
  expect(panel.flexDirection).toBe("column");
  expect(panel.height).not.toContain("680px");
});
