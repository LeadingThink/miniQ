import { describe, expect, it } from "vitest";
import { IOS_IAP_PACKS, IOS_IAP_PRODUCT_IDS, iosIapPack } from "./mobileIapConfig";

describe("iOS IAP configuration", () => {
  it("keeps a fixed allowlist of consumable credit packs", () => {
    expect(IOS_IAP_PRODUCT_IDS).toEqual([
      "com.leadingthink.miniq.credits.5",
      "com.leadingthink.miniq.credits.10",
      "com.leadingthink.miniq.credits.20",
      "com.leadingthink.miniq.credits.50",
      "com.leadingthink.miniq.credits.100",
      "com.leadingthink.miniq.credits.200",
      "com.leadingthink.miniq.credits.500",
      "com.leadingthink.miniq.credits.1000",
    ]);
    expect(new Set(IOS_IAP_PRODUCT_IDS).size).toBe(IOS_IAP_PRODUCT_IDS.length);
    expect(iosIapPack("com.leadingthink.miniq.credits.100")).toEqual(IOS_IAP_PACKS[4]);
    expect(iosIapPack("unknown")).toBeUndefined();
    expect(IOS_IAP_PACKS.map(({ productId, purchaseCents, creditCents }) => ({ productId, purchaseCents, creditCents }))).toEqual([
      { productId: "com.leadingthink.miniq.credits.5", purchaseCents: 500, creditCents: 500 },
      { productId: "com.leadingthink.miniq.credits.10", purchaseCents: 1_000, creditCents: 1_000 },
      { productId: "com.leadingthink.miniq.credits.20", purchaseCents: 2_000, creditCents: 2_000 },
      { productId: "com.leadingthink.miniq.credits.50", purchaseCents: 5_000, creditCents: 5_000 },
      { productId: "com.leadingthink.miniq.credits.100", purchaseCents: 10_000, creditCents: 10_000 },
      { productId: "com.leadingthink.miniq.credits.200", purchaseCents: 20_000, creditCents: 20_000 },
      { productId: "com.leadingthink.miniq.credits.500", purchaseCents: 50_000, creditCents: 50_000 },
      { productId: "com.leadingthink.miniq.credits.1000", purchaseCents: 100_000, creditCents: 100_000 },
    ]);
    expect(IOS_IAP_PACKS.every((pack) => pack.creditCents === pack.purchaseCents)).toBe(true);
  });

});
