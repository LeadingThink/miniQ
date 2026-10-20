import type { FilePreviewState } from "../hooks/useFilePreview";

export function FilePreviewAuthorization({ authorization }: {
  authorization: NonNullable<FilePreviewState["authorization"]>;
}) {
  return <section className="review-error preview-error" aria-label="确认文件授权">
    <div>
      <strong>允许读取此文件？</strong>
      <p style={{ overflowWrap: "anywhere" }}>{authorization.path}</p>
      <p>仅允许当前会话读取此文件，不会开放所在文件夹。桌面重启后需要重新授权。</p>
    </div>
    <button type="button" className="ghost" onClick={() => void authorization.confirm()}>允许并打开</button>
    <button type="button" className="ghost" onClick={() => void authorization.cancel()}>取消授权</button>
  </section>;
}
