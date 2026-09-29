// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  addPathToChat,
  chatMentionText,
  COMPOSER_INSERT_EVENT,
  copyText,
  parseLineNumber,
  relativePath,
  revealInFinder,
} from "./fileActions";

afterEach(() => vi.restoreAllMocks());

it("computes paths relative to the deepest workspace root", () => {
  expect(relativePath("/p/src/a.ts", ["/p"])).toBe("src/a.ts");
  expect(relativePath("/p/pkg/a.ts", ["/p", "/p/pkg", null])).toBe("a.ts");
  expect(relativePath("/p", ["/p/"])).toBe(".");
  expect(relativePath("C:\\w\\x.md", ["C:\\w"])).toBe("x.md");
  expect(relativePath("/elsewhere/a.ts", ["/p"])).toBe("/elsewhere/a.ts");
});

it("formats chat mentions and dispatches the composer insert event", () => {
  expect(chatMentionText("src/a.ts")).toBe("@src/a.ts ");
  expect(chatMentionText("a b/c.md")).toBe("@`a b/c.md` ");
  const listener = vi.fn();
  window.addEventListener(COMPOSER_INSERT_EVENT, listener);
  addPathToChat("/p/docs/read me.md", ["/p"]);
  window.removeEventListener(COMPOSER_INSERT_EVENT, listener);
  expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ text: "@`docs/read me.md` " });
});

it("validates line numbers", () => {
  expect(parseLineNumber("3", 10)).toEqual({ line: 3, error: null });
  expect(parseLineNumber(" 10 ", 10).line).toBe(10);
  for (const bad of ["0", "11", "x", "", "2.5"]) {
    expect(parseLineNumber(bad, 10)).toEqual({ line: null, error: "请输入 1 到 10 之间的行号" });
  }
});

it("reports clipboard and non-desktop failures in Chinese", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
  });
  await expect(copyText("x")).rejects.toThrow("无法访问剪贴板");
  await expect(revealInFinder("/p", { directory: true })).rejects.toThrow("仅桌面应用");
});
