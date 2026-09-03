import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl, shouldSyncBrowserAddress } from "./browserWorkbench";

describe("browser workbench URL policy", () => {
  it("normalizes bare domains to HTTPS", () => {
    expect(normalizeBrowserUrl("example.com/path")).toBe("https://example.com/path");
  });

  it("allows local HTTP development pages", () => {
    expect(normalizeBrowserUrl("http://127.0.0.1:5173/")).toBe(
      "http://127.0.0.1:5173/",
    );
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "mailto:test@example.com"])(
    "rejects non-web URL %s",
    (url) => expect(() => normalizeBrowserUrl(url)).toThrow("HTTP(S)"),
  );
});

describe("browser address synchronization", () => {
  it("does not overwrite an address while the user is editing it", () => {
    expect(shouldSyncBrowserAddress(true, "example.org", "https://old.test/")).toBe(false);
  });

  it("only follows navigation when the field still shows the previous page", () => {
    expect(shouldSyncBrowserAddress(false, "https://old.test/", "https://old.test/")).toBe(true);
    expect(shouldSyncBrowserAddress(false, "typed.test", "https://old.test/")).toBe(false);
  });
});
