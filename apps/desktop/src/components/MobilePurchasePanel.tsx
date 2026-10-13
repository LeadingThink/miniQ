import { useEffect, useRef, useState } from "react";
import { iosIapPurchaseBlockReason, purchaseIosCredits, retryIosTransactions } from "../iosIap";
import { loadIapPurchaseContext, type IapPurchaseContext } from "../mobileIapAccount";
import { iosIapPack } from "../mobileIapConfig";
import { useIosIapCatalog } from "../hooks/useIosIapCatalog";

export function MobilePurchasePanel(props: { disabled: boolean; onBusyChange: (busy: boolean) => void; onSettled: () => Promise<void> }) {
  const { catalog, loading, error: catalogError, reload } = useIosIapCatalog();
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
    const account = await loadIapPurchaseContext();
    setContext(account);
    const count = await retryIosTransactions(account);
    if (count) { setNotice("已处理未完成购买。"); await props.onSettled(); }
  };
  useEffect(() => { run(initialize); }, []);
  const disabled = pending || props.disabled || loading;
  const products = catalog?.products ?? [];
  const inconsistentCurrency = catalog?.storefront?.countryCode === "CHN"
    && products.some((product) => product.currencyCode !== "CNY");
  return <section className="mobile-purchase-panel" aria-label="购买 AI 使用额度">
    <div className="mobile-purchase-heading"><div><strong>购买 AI 使用额度</strong>
      <p>通过 Apple App 内购买充值到当前账户，充多少到账多少，不赠送。购买后可以在下方手动创建 Key。</p></div></div>
    {context?.environment === "Sandbox" && <p role="status">当前为测试账户。测试购买不会增加正式账户余额。</p>}
    {catalog && <div className="mobile-purchase-diagnostics" aria-label="Apple 商品信息">
      <p>Apple 商店地区：{catalog.storefront
        ? `${catalog.storefront.countryName}（${catalog.storefront.countryCode}），商店 ID：${catalog.storefront.id}`
        : "Apple 暂未返回，无法确认商店地区。"}</p>
      <p>地区来自 Apple 商店信息，不代表你的实际所在地。购买条件是币种为 CNY，且售价与额度包金额一致。</p>
      <p>切换商店或从系统设置返回时会自动重新查询商品，也可以手动重新加载。</p>
      {inconsistentCurrency && <p role="alert">Apple 返回的商店是中国，但部分商品币种不是人民币。本次重新查询后仍不一致，暂时无法购买；这不表示你的账号地区设置错误。</p>}
    </div>}
    {loading && <p role="status">正在重新查询 Apple 商店和商品，旧价格已清除…</p>}
    {pending && <p role="status">正在处理购买信息，请稍候…</p>}
    {catalog && products.length === 0 && <p>暂无可购买额度，请稍后重新加载。</p>}
    <div className="mobile-purchase-options">
      {products.map((product) => {
        const blockReason = iosIapPurchaseBlockReason(product);
        return <button key={product.productId} type="button" disabled={disabled || !context || !!blockReason} onClick={() => run(async () => {
          if (!context) return;
          const result = await purchaseIosCredits(product.productId, context);
          setNotice(result.status === "revoked" ? "此交易已撤销，未增加余额。" : `购买已确认，到账 ¥${(result.creditedCents / 100).toFixed(2)}。请在下方创建或复制 Key。`);
          await props.onSettled();
        })}>
          <span><strong>{product.displayName}</strong>
            <small>{blockReason ?? `到账 ¥${((iosIapPack(product.productId)?.creditCents ?? 0) / 100).toFixed(2)}`}</small>
            <small>Apple 售价：{product.currencyCode} {product.price}；要求：CNY {((iosIapPack(product.productId)?.purchaseCents ?? 0) / 100).toFixed(2)}</small>
          </span>
          <b>{product.displayPrice}</b>
        </button>;
      })}
    </div>
    <div className="mobile-account-actions">
      <button type="button" className="secondary" disabled={disabled} onClick={() => run(async () => { await Promise.all([initialize(), reload()]); })}>重新加载购买项目</button>
      <button type="button" className="secondary" disabled={disabled || !context} onClick={() => run(async () => {
        if (!context) return;
        const count = await retryIosTransactions(context);
        setNotice(count ? "已处理未完成购买。" : "没有待处理的购买。");
        await props.onSettled();
      })}>检查未完成购买</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {catalogError && <p className="mobile-entry-error" role="alert">{catalogError}</p>}
    {error && <p className="mobile-entry-error" role="alert">{error} 如已付款，请检查未完成购买，无需再次付款。</p>}
    <p className="mobile-purchase-footnote">余额跟随在问账户保存。已完成的消耗型购买无需恢复；未到账时，请登录购买时的手机号再检查。</p>
  </section>;
}
