import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { openExternalUrl } from "../externalLinks";
import { MODEL_RANKING_NOTICE, MODEL_RANKING_URL } from "../modelSelection";

/**
 * 在问平台的外链（默认是模型热度榜）。
 * 同一个组件复用到「查看模型可用性」，行为完全一致：走系统浏览器打开，
 * 不提交表单、不改动正在编辑的内容。
 */
export function ModelRankingLink({
  href = MODEL_RANKING_URL,
  label = "查看模型热度榜",
  notice = MODEL_RANKING_NOTICE,
  failure = "无法打开链接，请重试",
}: {
  href?: string;
  label?: string;
  notice?: string;
  failure?: string;
} = {}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="model-ranking-link">
      <a href={href} target="_blank" rel="noreferrer" title={notice} onClick={(event) => {
        event.preventDefault();
        setError(null);
        void openExternalUrl(href).catch(() => setError(failure));
      }}>
        {label}
        <ExternalLink size={13} />
      </a>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
