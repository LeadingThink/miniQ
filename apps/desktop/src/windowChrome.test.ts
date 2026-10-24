import { describe, expect, it } from "vitest";
import { isMacDesktop, isWindowsDesktop } from "./windowChrome";

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
