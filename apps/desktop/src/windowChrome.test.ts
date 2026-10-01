import { describe, expect, it } from "vitest";
import { isMacDesktop } from "./windowChrome";

describe("isMacDesktop", () => {
  it("only enables overlay chrome inside the macOS desktop runtime", () => {
    expect(isMacDesktop(true, "MacIntel Mozilla/5.0 (Macintosh)")).toBe(true);
    expect(isMacDesktop(false, "MacIntel Mozilla/5.0 (Macintosh)")).toBe(false);
    expect(isMacDesktop(true, "Win32 Mozilla/5.0 (Windows NT 10.0)")).toBe(false);
    expect(isMacDesktop(true, "iPhone Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(false);
  });
});
