// @vitest-environment jsdom
import { expect, it } from "vitest";
import { isolatedHtml } from "./htmlPreview";

it.each([false, true])("allows bundled data scripts without loosening other isolation (network=%s)", (network) => {
  const html = isolatedHtml('<script defer src="data:application/javascript;base64,YWxlcnQoMSk="></script>', network);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
  expect(policy).toContain("script-src 'unsafe-inline' 'unsafe-eval' data:");
  expect(policy).toContain(`connect-src ${network ? "https: http:" : "'none'"}`);
  expect(policy).toContain("frame-src 'none'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("base-uri 'none'");
  expect(policy).toContain("form-action 'none'");
  expect(doc.head.firstElementChild?.tagName).toBe("META");
  expect(doc.querySelector("script")?.hasAttribute("defer")).toBe(true);
  expect(doc.querySelector("script")?.getAttribute("src")).toContain("data:application/javascript;base64,");
});
