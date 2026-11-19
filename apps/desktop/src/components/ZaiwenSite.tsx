import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { listenBrowserEvent } from "../browserEvents";
import { useBrowserPanel } from "../hooks/useBrowserPanel";
import { openLinkWindow } from "../linkActions";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import type { RpcClient } from "../rpc";
import { isUsableDesktopAccountKey } from "../desktopAccountKey";
import { useZaiwenKeyImport } from "../hooks/useZaiwenKeyImport";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import "./ZaiwenSite.css";

const SITE_URL = "https://chat.zaiwenai.com/";

/** The main site owns its login, navigation and conversations. */
export function ZaiwenSite({ active, toolbar, client }: {
  active: boolean;
  toolbar?: HTMLElement | null;
  client?: RpcClient;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const browser = useBrowserPanel(SITE_URL, surface, !active, "zaiwen-site");
  const keyImport = useZaiwenKeyImport(active && !browser.loading && !browser.loadError, client);
  const { viewId, setError } = browser;
  useEffect(() => listenBrowserEvent("browser://new-window", viewId, ({ url }) => {
    void openLinkWindow(url).catch((cause) => setError(errorMessage(cause)));
  }), [viewId, setError]);
  const failure = browser.loadError;
  const keys = keyImport.prompt?.keys;
  const canCreate = !!keys && !keys.some(isUsableDesktopAccountKey);
  const keyStatus = keyImport.message || (keyImport.selectedKeyId ? "已选择在问 API Key" : keyImport.configured ? "已使用miniQ配置的API Key" : "");
  const retry = () => { void browser.load(failure?.url ?? browser.activeUrl).catch(() => {}); };
  return <main className="zaiwen-site" aria-label="在问主站" style={{ display: active ? undefined : "none" }} inert={!active}>
    {active && toolbar && createPortal(<div className="zaiwen-key-import">
      <Button className="zaiwen-key-import-button" variant="primary" size="sm" disabled={browser.loading || !!browser.loadError || keyImport.busy}
        onClick={() => void keyImport.request()}>选择在问 API Key</Button>
      {keyStatus && !keyImport.prompt && <span role="status">{keyStatus}</span>}
    </div>, toolbar)}
    <Dialog open={active && !!keyImport.prompt} title="选择 API Key"
      onClose={keyImport.dismiss} footer={<>
        <Button variant="secondary" data-autofocus onClick={keyImport.dismiss}>取消</Button>
        <Button disabled={keyImport.busy || (!!keys && !canCreate && !keyImport.prompt?.selectedKeyId)}
          onClick={() => void (keys ? keyImport.confirm() : keyImport.request())}>
          {keyImport.busy ? (keys ? "确认中…" : "加载中…") : !keys ? "重试" : canCreate ? "创建并使用" : "保存"}
        </Button>
      </>}>
      {!keys && keyImport.busy && <p role="status">正在加载 API Key…</p>}
      {keys?.length === 0 && <p>暂无 API Key</p>}
      {!!keys?.length && <fieldset className="zaiwen-key-choices" disabled={keyImport.busy}>
        <legend>全部 API Key（{keys.length}）</legend>
        {keys.map((key) => {
          const usable = isUsableDesktopAccountKey(key);
          const current = keyImport.selectedKeyId === key.key_id;
          return <label key={key.key_id} className="zaiwen-key-choice" aria-disabled={!usable || current}>
            <input type="radio" name="zaiwen-import-key" value={key.key_id} disabled={!usable || current}
              checked={keyImport.prompt?.selectedKeyId === key.key_id || (!keyImport.prompt?.selectedKeyId && current)}
              onChange={() => keyImport.selectKey(key.key_id)} />
            <span><strong>{key.remark || "未命名 Key"}</strong><code>{key.sk.length > 12
              ? `${key.sk.slice(0, 6)}••••${key.sk.slice(-4)}` : "••••••••"}</code>
              {!usable && <small>{key.is_active ? "已过期" : "已停用"}</small>}</span>
            {current && <small>当前已选</small>}
          </label>;
        })}
      </fieldset>}
      {keyImport.message && <p role="status">{keyImport.message}</p>}
    </Dialog>
    {browser.error && <div className="zaiwen-site-error" role="alert">
      <span>{browser.error}</span><button type="button" disabled={browser.pending} onClick={retry}>重试打开在问</button>
    </div>}
    <div ref={surface} className="zaiwen-site-surface" aria-busy={browser.loading}>
      {failure ? <section className="zaiwen-site-error" role="alert">
        <h2>无法打开在问主站</h2>
        <p>{failure.message}</p>
        <p>{failure.url}</p>
        <code>{failure.code}</code>
        <button type="button" disabled={browser.pending} onClick={retry}>重试打开在问</button>
      </section> : !isTauriRuntime() ? <iframe key={browser.revision} src={browser.activeUrl} title="在问主站网页"
        sandbox="allow-downloads allow-forms allow-popups allow-scripts allow-same-origin"
        onLoad={() => browser.setLoading(false)} onError={() => {
          browser.setLoading(false); setError("在问主站加载失败");
        }} /> : browser.loading ? <p role="status">正在加载在问主站…</p> : null}
    </div>
  </main>;
}
