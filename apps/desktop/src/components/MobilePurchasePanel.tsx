import { useEffect, useRef, useState } from "react";
import { isPurchasablePack, loadIosIapProducts, purchaseIosCredits, retryIosTransactions, type IosIapProduct } from "../iosIap";
import { loadIapPurchaseContext, type IapPurchaseContext } from "../mobileIapAccount";
import { iosIapPack } from "../mobileIapConfig";

export function MobilePurchasePanel(props: { disabled: boolean; onBusyChange: (busy: boolean) => void; onSettled: () => Promise<void> }) {
  const [products, setProducts] = useState<IosIapProduct[]>([]);
  const [context, setContext] = useState<IapPurchaseContext | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const working = useRef(false);
  const run = (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setPending(true); props.onBusyChange(true); setError(null); setNotice(null);
    void action().catch((cause) => setError(cause instanceof Error ? cause.message : "购买未完成，请稍后检查未完成购买。"))
      .finally(() => { working.current = false; setPending(false); props.onBusyChange(false); });
  };
  const initialize = async () => {
    setContext(null);
    const [account, catalog] = await Promise.all([loadIapPurchaseContext(), loadIosIapProducts()]);
    setContext(account); setProducts(catalog);
    const count = await retryIosTransactions(account);
    if (count) { setNotice("已处理未完成购买。"); await props.onSettled(); }
  };
  useEffect(() => { run(initialize); }, []);
  const disabled = pending || props.disabled;
  return <section className="mobile-purchase-panel" aria-label="购买 AI 使用额度">
    <div className="mobile-purchase-heading"><div><strong>购买 AI 使用额度</strong>
      <p>通过 Apple App 内购买充值到当前账户，充多少到账多少，不赠送。购买后可以在下方手动创建 Key。</p></div></div>
    {context?.environment === "Sandbox" && <p role="status">当前为测试账户。测试购买不会增加正式账户余额。</p>}
    {pending && <p role="status">正在处理购买信息，请稍候…</p>}
    {context && products.length === 0 && <p>暂无可购买额度，请稍后重新加载。</p>}
    <div className="mobile-purchase-options">
      {products.map((product) => <button key={product.productId} type="button" disabled={disabled || !context || !isPurchasablePack(product)} onClick={() => run(async () => {
        if (!context) return;
        const result = await purchaseIosCredits(product.productId, context);
        setNotice(result.status === "revoked" ? "此交易已撤销，未增加余额。" : `购买已确认，到账 ¥${(result.creditedCents / 100).toFixed(2)}。请在下方创建或复制 Key。`);
        await props.onSettled();
      })}>
        <span><strong>{product.displayName}</strong><small>{isPurchasablePack(product) ? `到账 ¥${((iosIapPack(product.productId)?.creditCents ?? 0) / 100).toFixed(2)}` : "当前地区或价格暂不支持"}</small></span>
        <b>{product.displayPrice}</b>
      </button>)}
    </div>
    <div className="mobile-account-actions">
      <button type="button" className="secondary" disabled={disabled} onClick={() => run(initialize)}>重新加载购买项目</button>
      <button type="button" className="secondary" disabled={disabled || !context} onClick={() => run(async () => {
        if (!context) return;
        const count = await retryIosTransactions(context);
        setNotice(count ? "已处理未完成购买。" : "没有待处理的购买。");
        await props.onSettled();
      })}>检查未完成购买</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p className="mobile-entry-error" role="alert">{error} 如已付款，请检查未完成购买，无需再次付款。</p>}
    <p className="mobile-purchase-footnote">余额跟随在问账户保存。已完成的消耗型购买无需恢复；未到账时，请登录购买时的手机号再检查。</p>
  </section>;
}
