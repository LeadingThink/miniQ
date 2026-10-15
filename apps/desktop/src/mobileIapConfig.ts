/** App Store Connect consumable products for miniQ's prepaid AI balance. */
export const IOS_IAP_PACKS = [
  { productId: "com.leadingthink.miniq.credits.5", creditCents: 500 },
  { productId: "com.leadingthink.miniq.credits.10", creditCents: 1_000 },
  { productId: "com.leadingthink.miniq.credits.20", creditCents: 2_000 },
  { productId: "com.leadingthink.miniq.credits.50", creditCents: 5_000 },
  { productId: "com.leadingthink.miniq.credits.100", creditCents: 10_000 },
  { productId: "com.leadingthink.miniq.credits.200", creditCents: 20_000 },
  { productId: "com.leadingthink.miniq.credits.500", creditCents: 50_000 },
  { productId: "com.leadingthink.miniq.credits.1000", creditCents: 100_000 },
] as const;

export const IOS_IAP_PRODUCT_IDS = IOS_IAP_PACKS.map((pack) => pack.productId);
export type IosIapProductId = (typeof IOS_IAP_PACKS)[number]["productId"];

export function iosIapPack(productId: string) {
  return IOS_IAP_PACKS.find((pack) => pack.productId === productId);
}
