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
