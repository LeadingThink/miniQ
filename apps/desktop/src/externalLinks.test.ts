import { describe, expect, it } from "vitest";
import { parseExternalUrl } from "./externalLinks";

const BASE_URL = "http://localhost:1420/conversation";

describe("external links", () => {
  it("accepts web links outside miniQ", () => {
    expect(parseExternalUrl("https://example.com/form", BASE_URL)?.href).toBe(
      "https://example.com/form",
    );
  });

  it("keeps same-origin and local links inside miniQ", () => {
    expect(parseExternalUrl("/settings", BASE_URL)).toBe(null);
    expect(parseExternalUrl("http://localhost:1420/help", BASE_URL)).toBe(null);
  });

  it("rejects unsupported protocols", () => {
    expect(parseExternalUrl("file:///tmp/report.txt", BASE_URL)).toBe(null);
    expect(parseExternalUrl("javascript:alert(1)", BASE_URL)).toBe(null);
  });
});
