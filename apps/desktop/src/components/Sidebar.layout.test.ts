// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

it.each(["session-copy", "session-copy with-context"])(
  "keeps a single bounded title row: %s",
  (className) => {
    const style = document.createElement("style");
    style.textContent = ["src/styles/shell.css", "src/components/Sidebar.css"]
      .map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");
    document.head.append(style);
    document.body.innerHTML = `<aside class="sidebar"><button class="session-select"><span class="${className}"><span class="session-title">会话标题</span><span class="session-meta">刚刚</span></span></button></aside>`;
    const copy = getComputedStyle(document.querySelector(".session-copy")!);
    expect(copy.display).toBe("flex");
    expect(copy.flexDirection).toBe("row");
    expect(parseFloat(copy.minWidth)).toBe(0);
    expect(getComputedStyle(document.querySelector(".session-title")!).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(document.querySelector(".session-meta")!).display).toBe("flex");
  },
);

it("renders the project count as inline title text instead of a badge", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(process.cwd(), "src/components/Sidebar.css"), "utf8");
  document.head.append(style);
  document.body.innerHTML = `<aside class="sidebar"><div class="sidebar-section-heading"><span class="sidebar-section-title">工作区与项目<span class="sidebar-section-count">(1)</span></span></div></aside>`;
  const count = getComputedStyle(document.querySelector(".sidebar-section-count")!);
  expect(count.display).toBe("inline");
  expect(count.marginLeft).toBe("0px");
  expect(count.paddingLeft).toBe("0px");
  expect(count.backgroundColor).toBe("rgba(0, 0, 0, 0)");
});
