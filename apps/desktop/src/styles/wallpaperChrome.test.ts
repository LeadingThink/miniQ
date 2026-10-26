// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete document.documentElement.dataset.background;
  document.documentElement.classList.remove("platform-macos");
});

it.each(["windows", "macos", "linux"])("keeps the complete %s desktop shell above wallpaper across background changes", (platform) => {
  if (platform === "macos") document.documentElement.classList.add("platform-macos");
  const style = document.createElement("style");
  style.textContent = [
    "src/components/AppMenuBar.css",
    "src/styles/living-background.css",
    "src/styles/window-chrome.css",
  ].map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");
  document.head.append(style);
  document.body.innerHTML = '<div class="living-background"></div><div class="desktop-workspace"><header class="app-menubar">miniQ</header><div class="app"></div></div>';
  const shell = document.querySelector(".desktop-workspace")!;
  const wallpaper = document.querySelector(".living-background")!;
  for (const background of ["image", "video", "", "image"]) {
    if (background) document.documentElement.dataset.background = background;
    else delete document.documentElement.dataset.background;
    if (background) {
      expect(getComputedStyle(shell).position).toBe("relative");
      expect(Number(getComputedStyle(shell).zIndex)).toBeGreaterThan(Number(getComputedStyle(wallpaper).zIndex));
    }
    expect(getComputedStyle(document.querySelector(".app-menubar")!).display).toBe("flex");
  }
  expect(getComputedStyle(wallpaper).pointerEvents).toBe("none");
  if (platform === "macos") {
    expect(getComputedStyle(document.querySelector(".app-menubar")!).paddingLeft).toBe("84px");
  }
});