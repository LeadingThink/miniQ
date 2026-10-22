// @vitest-environment jsdom
import { expect, it } from "vitest";
import { resolveMarkdownLinkTarget as resolve } from "./markdownLinkTarget";

it("keeps encoded filename hashes separate from source locations", () => {
  expect(resolve("/w/报告%23L10.md#L2C3")).toEqual({ kind: "file", target: { path: "/w/报告#L10.md", line: 2, column: 3 } });
  expect(resolve("C:/资料/报告%20一.md:12:4")).toEqual({ kind: "file", target: { path: "C:/资料/报告 一.md", line: 12, column: 4 } });
  expect(resolve("file://server/share/a.pdf")).toEqual({ kind: "file", target: { path: "\\\\server\\share\\a.pdf", line: null, column: null } });
});
it("resolves relative directories, rejects unsafe schemes and preserves web targets", () => {
  expect(resolve("src/", "/w")).toEqual({ kind: "file", target: { path: "/w/src/", line: null, column: null } });
  for (const href of ["javascript:alert(1)", "data:text/plain,x", "#heading"]) expect(resolve(href, "/w")).toBeNull();
  expect(resolve("https://example.com/a.pdf")).toEqual({ kind: "url", url: "https://example.com/a.pdf" });
});
