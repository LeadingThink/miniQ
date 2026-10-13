import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getProducts: vi.fn(), purchase: vi.fn(), getUnfinishedTransactions: vi.fn(), finishTransaction: vi.fn(), addListener: vi.fn(),
  request: vi.fn(), context: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "ios" }, registerPlugin: () => mocks }));
vi.mock("./mobileIapAccount", async (original) => ({ ...(await original<typeof import("./mobileIapAccount")>()),
  oneApiRequest: mocks.request, loadIapPurchaseContext: mocks.context,
}));
import { acknowledgeIosTransaction, loadIosIapCatalog, purchaseIosCredits, recoverIosTransactions, retryIosTransactions, type IosIapTransaction } from "./iosIap";
const context = { accountId: "u1", appAccountToken: "00000000-0000-4000-8000-000000000001", environment: "Production" as const };
const transaction: IosIapTransaction = { productId: "com.leadingthink.miniq.credits.100", transactionId: "123", originalTransactionId: "123", signedTransaction: "signed.jws.payload", appAccountToken: context.appAccountToken };
const receipt = { ...context, transactionId: "123", status: "credited", creditedCents: 10000, balanceYuan: 120.005 };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue(context);
  mocks.getProducts.mockResolvedValue({ products: [{ productId: transaction.productId, currencyCode: "CNY", price: "100" }] });
  mocks.purchase.mockResolvedValue(transaction);
  mocks.request.mockResolvedValue(receipt);
  mocks.finishTransaction.mockResolvedValue(undefined);
  mocks.getUnfinishedTransactions.mockResolvedValue({ transactions: [transaction] });
});
it("binds a purchase to the logged-in account and finishes only after server acknowledgement", async () => {
  expect(await purchaseIosCredits(transaction.productId, context)).toEqual(receipt);
  expect(mocks.purchase).toHaveBeenCalledWith({ productId: transaction.productId, appAccountToken: context.appAccountToken,
    expectedPrice: "100", expectedCurrency: "CNY" });
  expect(mocks.request).toHaveBeenCalledWith("/iap/apple/transactions", transaction);
  expect(mocks.finishTransaction).toHaveBeenCalledWith({ transactionId: "123" });
  expect(mocks.request.mock.invocationCallOrder[0]).toBeLessThan(mocks.finishTransaction.mock.invocationCallOrder[0]);
});
it.each([
  { price: "14.99", currencyCode: "USD", reason: "币种不支持：Apple 返回 USD，目前仅支持人民币（CNY）。" },
  { price: "98", currencyCode: "CNY", reason: "售价不匹配：Apple 返回 CNY 98，此额度包要求 CNY 100.00。" },
])("explains why $currencyCode $price is blocked before payment", async ({ reason, ...product }) => {
  mocks.getProducts.mockResolvedValue({ products: [{ ...product, productId: transaction.productId }] });
  await expect(purchaseIosCredits(transaction.productId, context)).rejects.toThrow(reason);
  expect(mocks.purchase).not.toHaveBeenCalled();
});
it("distinguishes a missing product from currency and price restrictions", async () => {
  mocks.getProducts.mockResolvedValue({ products: [], storefront: null });
  await expect(purchaseIosCredits(transaction.productId, context)).rejects.toThrow("Apple 未返回此额度包");
  expect(mocks.purchase).not.toHaveBeenCalled();
});
it("preserves Apple's storefront independently of the product currency", async () => {
  const storefront = { id: "143465", countryCode: "CHN", countryName: "中国大陆" };
  const product = { productId: transaction.productId, price: "14.99", currencyCode: "USD" };
  mocks.getProducts.mockResolvedValue({ storefront, products: [product, { ...product, productId: "unconfigured" }] });
  expect(await loadIosIapCatalog()).toEqual({ storefront, products: [product] });
});
it("blocks account switching before payment and mismatched ownership before submission", async () => {
  mocks.context.mockResolvedValue({ ...context, accountId: "u2" });
  await expect(purchaseIosCredits(transaction.productId, context)).rejects.toThrow("登录账户已变化");
  await expect(acknowledgeIosTransaction({ ...transaction, appAccountToken: "other" }, context)).rejects.toThrow("其他账户");
  expect(mocks.purchase).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
});
it.each([
  { accountId: "u2" }, { environment: "Sandbox" }, { transactionId: "wrong" },
  { creditedCents: 12000 }, { status: "pending" }, { appAccountToken: "other" },
])("does not finish after an invalid settlement: %j", async (change) => {
  mocks.request.mockResolvedValue({ ...receipt, ...change });
  await expect(acknowledgeIosTransaction(transaction, context)).rejects.toThrow("尚未确认到账");
  expect(mocks.finishTransaction).not.toHaveBeenCalled();
});
it("deduplicates concurrent callbacks and leaves network failures available for retry", async () => {
  mocks.request.mockRejectedValueOnce(new Error("offline"));
  const first = acknowledgeIosTransaction(transaction, context);
  expect(acknowledgeIosTransaction(transaction, context)).toBe(first);
  await expect(first).rejects.toThrow("offline");
  expect(mocks.finishTransaction).not.toHaveBeenCalled();
  expect(await retryIosTransactions(context)).toBe(1);
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(mocks.finishTransaction).toHaveBeenCalledTimes(1);
});
it("finishes already-credited and terminally revoked transactions without requesting another payment", async () => {
  for (const status of ["already_credited", "revoked"]) {
    mocks.request.mockResolvedValue({ ...receipt, status, creditedCents: status === "revoked" ? 0 : 10000 });
    await acknowledgeIosTransaction(transaction, context);
  }
  expect(mocks.purchase).not.toHaveBeenCalled();
  expect(mocks.finishTransaction).toHaveBeenCalledTimes(2);
});
it("background recovery processes only the currently logged-in account", async () => {
  mocks.getUnfinishedTransactions.mockResolvedValue({ transactions: [{ ...transaction, transactionId: "other", appAccountToken: "other" }, transaction] });
  await recoverIosTransactions();
  expect(mocks.request).toHaveBeenCalledTimes(1);
  expect(mocks.finishTransaction).toHaveBeenCalledWith({ transactionId: "123" });
});
it("does not contact the account service when no purchases need recovery", async () => {
  mocks.getUnfinishedTransactions.mockResolvedValue({ transactions: [] });
  await recoverIosTransactions(); expect(mocks.context).not.toHaveBeenCalled();
});
