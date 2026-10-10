import { describe, expect, it } from "vitest";
import { isPrivateBrowserHost, normalizeBrowserUrl, resolveBrowserAddress, shouldSyncBrowserAddress } from "./browserWorkbench";

describe("browser workbench URL policy", () => {
  it.each(["localhost:3000", "[::1]:3000"])("defaults local host and port %s to HTTP", (value) => {
    expect(normalizeBrowserUrl(value)).toBe(`http://${value}/`);
  });
  it("keeps HTTPS for public host and port", () => {
    expect(normalizeBrowserUrl("example.com:8443")).toBe("https://example.com:8443/");
  });
  it.each(["https://user:password@example.com", "https://user@example.com", "https://exam\nple.com"])(
    "rejects credentials and control characters %s",
    (value) => {
      expect(() => normalizeBrowserUrl(value)).toThrow();
    },
  );
  it("normalizes bare domains to HTTPS", () => {
    expect(normalizeBrowserUrl("example.com/path")).toBe("https://example.com/path");
  });

  it("allows local HTTP development pages", () => {
    expect(normalizeBrowserUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
  });

  it.each(["file:///etc/passwd", "javascript:alert(1)", "mailto:test@example.com"])("rejects non-web URL %s", (url) =>
    expect(() => normalizeBrowserUrl(url)).toThrow("HTTP(S)"),
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

describe("address bar input", () => {
  it.each([
    ["example.com", "https://example.com/"],
    ["example.com/path?q=1", "https://example.com/path?q=1"],
    ["https://example.com/a b".replace(" ", "%20"), "https://example.com/a%20b"],
    ["  docs.rs  ", "https://docs.rs/"],
    ["http://example.com/", "http://example.com/"],
    ["localhost", "http://localhost/"],
    ["localhost:3000/app", "http://localhost:3000/app"],
    ["127.0.0.1:5173", "http://127.0.0.1:5173/"],
    ["192.168.1.20", "http://192.168.1.20/"],
    ["10.0.0.8:8080", "http://10.0.0.8:8080/"],
    ["172.20.1.1", "http://172.20.1.1/"],
    ["printer.local", "http://printer.local/"],
    ["[::1]:3000", "http://[::1]:3000/"],
    ["8.8.8.8", "https://8.8.8.8/"],
  ])("opens %s as a URL", (input, expected) => {
    expect(resolveBrowserAddress(input)).toBe(expected);
  });

  it.each(["rust tutorial", "miniq", "1.5", "what is a.b", "你好 世界", "a@b.com", "c++: tips"])("searches Bing for %s", (input) => {
    expect(resolveBrowserAddress(input)).toBe(`https://www.bing.com/search?q=${encodeURIComponent(input.trim())}`);
  });

  it.each(["javascript:alert(1)", "javascript: alert(1)", "file:///etc/passwd", "data:text/html,hi", "mailto:a@b.com"])(
    "rejects non-web scheme %s",
    (input) => expect(() => resolveBrowserAddress(input)).toThrow("HTTP(S)"),
  );

  it.each(["https://user:pw@example.com", "user:pw@example.com"])("rejects credentials %s", (input) => {
    expect(() => resolveBrowserAddress(input)).toThrow("账号或密码");
  });

  it("rejects empty and control-character input", () => {
    expect(() => resolveBrowserAddress("   ")).toThrow();
    expect(() => resolveBrowserAddress("exam\nple.com")).toThrow();
  });

  it("classifies private hosts", () => {
    expect(isPrivateBrowserHost("172.15.0.1")).toBe(false);
    expect(isPrivateBrowserHost("172.31.0.1")).toBe(true);
    expect(isPrivateBrowserHost("app.localhost")).toBe(true);
    expect(isPrivateBrowserHost("example.com")).toBe(false);
  });
});
