import { isUsableDesktopAccountKey } from "../desktopAccountKey";
import type { useZaiwenKeyImport } from "../hooks/useZaiwenKeyImport";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import "./ZaiwenKeyDialog.css";

export function ZaiwenKeyDialog({ open, keyImport }: {
  open: boolean;
  keyImport: ReturnType<typeof useZaiwenKeyImport>;
}) {
  const keys = keyImport.prompt?.keys;
  const canCreate = !!keys && !keys.some(isUsableDesktopAccountKey);
  const loading = !keys && !keyImport.message;
  return <Dialog open={open && !!keyImport.prompt} title="选择 API Key"
    description="请选择用于 miniQ 的在问 API Key，保存后即可使用。"
    onClose={keyImport.dismiss} footer={<>
      <Button variant="secondary" data-autofocus onClick={keyImport.dismiss}>取消</Button>
      <Button disabled={loading || keyImport.busy || (!!keys && !canCreate && !keyImport.prompt?.selectedKeyId)}
        onClick={() => void (keys ? keyImport.confirm() : keyImport.request())}>
        {loading ? "加载中…" : keyImport.busy ? "保存中…" : !keys ? "重试" : canCreate ? "创建并使用" : "保存"}
      </Button>
    </>}>
    {loading && <p role="status">正在加载 API Key…</p>}
    {keys?.length === 0 && <p>暂无 API Key</p>}
    {!!keys?.length && <fieldset className="zaiwen-key-choices" disabled={keyImport.busy}>
      <legend>全部 API Key（{keys.length}）</legend>
      {keys.map((key) => {
        const usable = isUsableDesktopAccountKey(key);
        return <label key={key.key_id} className="zaiwen-key-choice" aria-disabled={!usable}>
          <input type="radio" name="zaiwen-import-key" value={key.key_id} disabled={!usable}
            checked={keyImport.prompt?.selectedKeyId === key.key_id}
            onChange={() => keyImport.selectKey(key.key_id)} />
          <span><strong>{key.remark || "未命名 Key"}</strong><code>{key.sk.length > 12
            ? `${key.sk.slice(0, 6)}••••${key.sk.slice(-4)}` : "••••••••"}</code>
            {!usable && <small>{key.is_active ? "已过期" : "已停用"}</small>}</span>
        </label>;
      })}
    </fieldset>}
    {keyImport.message && <p role="status">{keyImport.message}</p>}
  </Dialog>;
}
