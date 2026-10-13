import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { IOS_IAP_PRODUCT_IDS, iosIapPack, type IosIapProductId } from "./mobileIapConfig";
import { isRecord, oneApiRequest, loadIapPurchaseContext, type IapPurchaseContext } from "./mobileIapAccount";

export interface IosIapProduct {
  productId: IosIapProductId;
  displayName: string;
  description: string;
  displayPrice: string;
  price: string;
  currencyCode: string;
}
export interface IosIapCatalog {
  products: IosIapProduct[];
  storefront: { id: string; countryCode: string; countryName: string } | null;
}
export interface IosIapTransaction {
  productId: IosIapProductId;
  transactionId: string;
  originalTransactionId: string;
  signedTransaction: string;
  appAccountToken?: string;
}
export interface IapSettlement extends IapPurchaseContext {
  transactionId: string;
  status: "credited" | "already_credited" | "revoked";
  creditedCents: number;
  balanceYuan: number;
}
interface IosIapPlugin {
  getProducts(options: { productIds: readonly string[] }): Promise<IosIapCatalog>;
  purchase(options: { productId: string; appAccountToken: string }): Promise<IosIapTransaction>;
  getUnfinishedTransactions(): Promise<{ transactions: IosIapTransaction[] }>;
  finishTransaction(options: { transactionId: string }): Promise<void>;
  addListener(event: "transactionUpdated", listener: () => void): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<IosIapPlugin>("MiniqIap");
const acknowledgements = new Map<string, Promise<IapSettlement>>();

export function isIosIapAvailable(): boolean { return Capacitor.getPlatform() === "ios"; }
function ensureIos(): void { if (!isIosIapAvailable()) throw new Error("App 内购买仅适用于 iOS App"); }

export function iosIapPurchaseBlockReason(product: IosIapProduct): string | null {
  const pack = iosIapPack(product.productId);
  if (!pack) return "未配置此额度包，暂时无法购买。";
  if (product.currencyCode !== "CNY") {
    return `币种不支持：Apple 返回 ${product.currencyCode}，目前仅支持人民币（CNY）。`;
  }
  if (Number(product.price) * 100 !== pack.purchaseCents) {
    return `售价不匹配：Apple 返回 CNY ${product.price}，此额度包要求 CNY ${(pack.purchaseCents / 100).toFixed(2)}。`;
  }
  return null;
}

export async function loadIosIapCatalog(): Promise<IosIapCatalog> {
  ensureIos();
  const result = await plugin.getProducts({ productIds: IOS_IAP_PRODUCT_IDS });
  return { ...result, products: result.products.filter((product) => IOS_IAP_PRODUCT_IDS.includes(product.productId)) };
}

export async function purchaseIosCredits(productId: IosIapProductId, context: IapPurchaseContext): Promise<IapSettlement> {
  ensureIos();
  const current = await loadIapPurchaseContext();
  if (current.accountId !== context.accountId || current.appAccountToken !== context.appAccountToken
    || current.environment !== context.environment) throw new Error("登录账户已变化，请重新打开账户页面。");
  const product = (await loadIosIapCatalog()).products.find((item) => item.productId === productId);
  if (!product) throw new Error("Apple 未返回此额度包，请重新加载购买项目。");
  const blockReason = iosIapPurchaseBlockReason(product);
  if (blockReason) throw new Error(blockReason);
  const transaction = await plugin.purchase({ productId, appAccountToken: context.appAccountToken });
  return acknowledgeIosTransaction(transaction, context);
}

function parseSettlement(value: unknown, transaction: IosIapTransaction, context: IapPurchaseContext): IapSettlement {
  const pack = iosIapPack(transaction.productId);
  if (!isRecord(value) || value.accountId !== context.accountId || value.appAccountToken !== context.appAccountToken
    || value.environment !== context.environment || value.transactionId !== transaction.transactionId
    || !["credited", "already_credited", "revoked"].includes(value.status as string)
    || value.creditedCents !== (value.status === "revoked" ? 0 : pack?.creditCents)
    || typeof value.balanceYuan !== "number" || !Number.isFinite(value.balanceYuan)) {
    throw new Error("交易尚未确认到账，请稍后检查未完成购买，无需再次付款。");
  }
  return value as unknown as IapSettlement;
}

export function acknowledgeIosTransaction(transaction: IosIapTransaction, context: IapPurchaseContext): Promise<IapSettlement> {
  if (transaction.appAccountToken?.toLowerCase() !== context.appAccountToken) {
    return Promise.reject(new Error("这笔购买属于其他账户，请登录购买时的账户后重试。"));
  }
  if (!IOS_IAP_PRODUCT_IDS.includes(transaction.productId) || !transaction.signedTransaction
    || !transaction.transactionId || !transaction.originalTransactionId) {
    return Promise.reject(new Error("购买凭证不完整，暂时无法确认到账。"));
  }
  const key = JSON.stringify([context.accountId, context.environment, transaction.transactionId]);
  const pending = acknowledgements.get(key);
  if (pending) return pending;
  const run = (async () => {
    const body = await oneApiRequest("/iap/apple/transactions", transaction);
    const settlement = parseSettlement(body, transaction, context);
    await plugin.finishTransaction({ transactionId: transaction.transactionId });
    return settlement;
  })().finally(() => acknowledgements.delete(key));
  acknowledgements.set(key, run);
  return run;
}

export async function retryIosTransactions(context: IapPurchaseContext): Promise<number> {
  ensureIos();
  const { transactions } = await plugin.getUnfinishedTransactions();
  const failures: unknown[] = [];
  for (const transaction of transactions) {
    try { await acknowledgeIosTransaction(transaction, context); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new Error(`还有 ${failures.length} 笔购买未确认。请确认登录的是购买时的账户，稍后点“检查未完成购买”，无需再次付款。`);
  return transactions.length;
}

export async function observeIosTransactions(onUpdate: () => void): Promise<PluginListenerHandle> {
  ensureIos();
  return plugin.addListener("transactionUpdated", onUpdate);
}

export async function recoverIosTransactions(): Promise<void> {
  ensureIos();
  const { transactions } = await plugin.getUnfinishedTransactions();
  if (!transactions.length) return;
  const context = await loadIapPurchaseContext();
  // A single device may contain purchases for several website accounts.
  for (const transaction of transactions) {
    if (transaction.appAccountToken?.toLowerCase() === context.appAccountToken) {
      await acknowledgeIosTransaction(transaction, context);
    }
  }
}
