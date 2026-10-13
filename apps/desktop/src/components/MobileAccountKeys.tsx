import { useEffect, useState } from "react";
import { createOneApiKey, loadOneApiKeys, type OneApiKey, type OneApiKeysPage } from "../mobileIapAccount";
import type { AccountAction } from "./MobileAccountLogin";
import { copyText } from "../fileActions";

function KeyItem({ item, busy, run }: { item: OneApiKey; busy: boolean; run: AccountAction }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const expired = item.expire_time <= Date.now() / 1000;
  return <li className="mobile-account-key">
    <strong>{item.remark || "未命名 Key"}{!item.is_active ? "（已停用）" : expired ? "（已过期）" : ""}</strong>
    <input aria-label={`${item.remark || "未命名 Key"} 的 API Key`} readOnly type={visible ? "text" : "password"} value={item.sk}
      autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
    <div className="mobile-account-actions">
      <button type="button" className="secondary" onClick={() => setVisible(!visible)}>{visible ? "隐藏" : "显示"}</button>
      <button type="button" disabled={busy} onClick={() => run(async () => {
        try { await copyText(item.sk); setCopied(true); }
        catch { throw new Error("复制失败，请显示 Key 后长按复制。"); }
      })}>{copied ? "已复制" : "复制 Key"}</button>
    </div>
  </li>;
}

export function MobileAccountKeys(props: { busy: boolean; run: AccountAction }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<OneApiKeysPage>({ total: 0, keys: [] });
  const [loaded, setLoaded] = useState(false);
  const [remark, setRemark] = useState("miniQ");
  const [created, setCreated] = useState<OneApiKey | null>(null);
  const loadPage = async (next: number) => { const data = await loadOneApiKeys(next); setResult(data); setPage(next); setLoaded(true); };
  useEffect(() => { props.run(() => loadPage(1)); }, []);
  return <section aria-label="手动创建 API Key" className="mobile-account-keys">
    <h2>创建与复制 API Key</h2>
    <p>所有 Key 使用所属账户的余额。复制后返回上一页，手动粘贴并保存。</p>
    <label className="mobile-entry-field">Key 名称<input value={remark} disabled={props.busy} onChange={(event) => setRemark(event.target.value)} /></label>
    <button type="button" disabled={props.busy} onClick={() => props.run(async () => {
      setCreated(await createOneApiKey(remark));
      await loadPage(1);
    })}>创建 API Key</button>
    {created && <div role="status"><p>Key 已创建，请复制保存。</p>{!result.keys.some((item) => item.key_id === created.key_id)
      && <ul className="mobile-account-key-list"><KeyItem key={created.key_id} item={created} busy={props.busy} run={props.run} /></ul>}</div>}
    <h3>已有 Key</h3>
    {loaded && result.total === 0 && <p>还没有 Key，可点击上方按钮创建。</p>}
    <ul className="mobile-account-key-list">{result.keys.map((item) => <KeyItem key={item.key_id} item={item} busy={props.busy} run={props.run} />)}</ul>
    <div className="mobile-account-actions">
      <button type="button" className="secondary" disabled={props.busy || page <= 1} onClick={() => props.run(() => loadPage(page - 1))}>上一页</button>
      <span>第 {page} 页 · 共 {result.total} 个</span>
      <button type="button" className="secondary" disabled={props.busy || page * 10 >= result.total} onClick={() => props.run(() => loadPage(page + 1))}>下一页</button>
      <button type="button" className="secondary" disabled={props.busy} onClick={() => props.run(() => loadPage(page))}>刷新 Key 列表</button>
    </div>
  </section>;
}
