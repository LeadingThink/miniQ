import { useState } from "react";
import { openExternalUrl } from "../externalLinks";
import { MODEL_RANKING_NOTICE, MODEL_RANKING_URL } from "../modelSelection";

export function ModelRankingLink() {
  const [error, setError] = useState<string | null>(null);
  return <span style={{ display: "block", fontSize: "12px" }}>
    <a href={MODEL_RANKING_URL} target="_blank" rel="noreferrer" onClick={(event) => {
      event.preventDefault();
      setError(null);
      void openExternalUrl(MODEL_RANKING_URL).catch(() => setError("无法打开热度榜，请重试"));
    }}>查看模型热度榜</a>
    <small style={{ display: "block" }}>{MODEL_RANKING_NOTICE}</small>
    {error && <span role="alert">{error}</span>}
  </span>;
}
