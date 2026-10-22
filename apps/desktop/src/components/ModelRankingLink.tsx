import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { openExternalUrl } from "../externalLinks";
import { MODEL_RANKING_NOTICE, MODEL_RANKING_URL } from "../modelSelection";

export function ModelRankingLink() {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="model-ranking-link">
      <a href={MODEL_RANKING_URL} target="_blank" rel="noreferrer" title={MODEL_RANKING_NOTICE} onClick={(event) => {
        event.preventDefault();
        setError(null);
        void openExternalUrl(MODEL_RANKING_URL).catch(() => setError("无法打开热度榜，请重试"));
      }}>
        查看模型热度榜
        <ExternalLink size={13} />
      </a>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
