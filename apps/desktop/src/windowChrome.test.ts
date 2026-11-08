import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isMacDesktop, isWindowsDesktop } from "./windowChrome";

// AppKit traffic lights are 14pt tall with ~23pt between button origins.
// The 24pt vertical inset is calibrated from macOS screenshots: 30pt renders
// 6pt too low and 18pt renders 6pt too high relative to the WebView brand.
const TRAFFIC_LIGHT_SIZE = 14;
const TRAFFIC_LIGHT_SPACING = 23;

it("aligns macOS traffic lights with the title row and keeps them clear of the brand", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
  const { x, y } = JSON.parse(read("src-tauri/tauri.conf.json")).app.windows[0].trafficLightPosition;
  const inset = Number(/\.platform-macos \.app-menubar \{[^}]*padding-left: (\d+)px/.exec(read("src/styles/window-chrome.css"))![1]);
  expect(y).toBe(24);
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
