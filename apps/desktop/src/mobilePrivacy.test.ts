import { describe, expect, it } from "vitest";
import { clearMobilePrivacyConsent, hasMobilePrivacyConsent, recordMobilePrivacyConsent } from "./mobilePrivacy";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("mobile privacy consent", () => {
  it("requires the current policy version and records it independently of credentials", () => {
    const target = storage();
    expect(hasMobilePrivacyConsent(target)).toBe(false);
    target.setItem("miniq.remote.credentials.persist.v1", "saved-key");
    expect(hasMobilePrivacyConsent(target)).toBe(false);

    recordMobilePrivacyConsent(target);

    expect(hasMobilePrivacyConsent(target)).toBe(true);
    expect(target.getItem("miniq.remote.credentials.persist.v1")).toBe("saved-key");
    clearMobilePrivacyConsent(target);
    expect(hasMobilePrivacyConsent(target)).toBe(false);
    expect(target.getItem("miniq.remote.credentials.persist.v1")).toBe("saved-key");
  });
});
