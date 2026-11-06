import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isMacDesktop, isWindowsDesktop } from "./windowChrome";

// AppKit traffic lights are 14pt tall with ~23pt between button origins.
const TRAFFIC_LIGHT_SIZE = 14;
const TRAFFIC_LIGHT_SPACING = 23;

it("centers macOS traffic lights in the title row and keeps them clear of the brand", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
  const { x, y } = JSON.parse(read("src-tauri/tauri.conf.json")).app.windows[0].trafficLightPosition;
  const barHeight = Number(/\.app-menubar \{[^}]*flex: 0 0 (\d+)px/.exec(read("src/components/AppMenuBar.css"))![1]);
  const inset = Number(/\.platform-macos \.app-menubar \{[^}]*padding-left: (\d+)px/.exec(read("src/styles/window-chrome.css"))![1]);
  // tao resizes the titlebar container to `14 + y` and AppKit centers the buttons in it.
  expect((TRAFFIC_LIGHT_SIZE + y) / 2).toBe(barHeight / 2);
  const zoomRight = x + 2 * TRAFFIC_LIGHT_SPACING + TRAFFIC_LIGHT_SIZE;
  expect(inset - zoomRight).toBe(x);
});

describe("isMacDesktop", () => {
  it("only enables overlay chrome inside the macOS desktop runtime", () => {
    expect(isMacDesktop(true, "MacIntel Mozilla/5.0 (Macintosh)")).toBe(true);
    expect(isMacDesktop(false, "MacIntel Mozilla/5.0 (Macintosh)")).toBe(false);
    expect(isMacDesktop(true, "Win32 Mozilla/5.0 (Windows NT 10.0)")).toBe(false);
    expect(isMacDesktop(true, "iPhone Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(false);
  });
});

it("only renders custom Windows controls in the Windows desktop runtime", () => {
  expect(isWindowsDesktop(true, "Win32 Windows NT 10.0")).toBe(true);
  expect(isWindowsDesktop(false, "Win32 Windows NT 10.0")).toBe(false);
  expect(isWindowsDesktop(true, "MacIntel")).toBe(false);
  expect(isWindowsDesktop(true, "Linux x86_64")).toBe(false);
});
