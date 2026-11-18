import type { ZaiwenMessage } from "../zaiwenHistory";
import { webMarkdownUrl } from "../markdownPolicy";
import { openExternalUrl } from "../externalLinks";

function assets(value: unknown): { url: string; name: string; image: boolean }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const asset = item as Record<string, unknown>;
    const url = webMarkdownUrl(asset.url);
    if (!url || url.startsWith("#")) return [];
    return [{ url, name: typeof asset.name === "string" ? asset.name : "附件",
      image: typeof asset.format === "string" && asset.format.startsWith("image/") }];
  });
}

export function ZaiwenMessageAssets({ message, onOpenSite }: { message: ZaiwenMessage; onOpenSite: () => void }) {
  const links = assets(message.assets);
  const hiddenAssets = Array.isArray(message.assets) && message.assets.length > links.length;
  const complex = hiddenAssets || (message.type && message.type !== "text") || message.draw_result || message.video_result || message.suno_result;
  return <>
    {links.map((asset, index) => <div className="zaiwen-history-asset" key={`${asset.url}-${index}`}>
      {asset.image && <img src={asset.url} alt={asset.name} loading="lazy" referrerPolicy="no-referrer" />}
      <a href={asset.url} target="_blank" rel="noopener noreferrer" onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(asset.url).catch(() => undefined);
      }}>{asset.name}</a>
    </div>)}
    {complex && <p className="zaiwen-history-rich-result">此消息包含主站作品或专用内容。<button type="button" className="ghost" onClick={onOpenSite}>在主站查看完整结果</button></p>}
    {!message.content && !links.length && !complex && <p>（此消息没有文本内容）</p>}
  </>;
}
