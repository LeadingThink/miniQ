import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import { MOBILE_API_BASE_URL, MOBILE_MODEL_STORAGE_KEY, mobileResponseError, textChatModels } from "../mobileChatData";

export function useMobileChatModels(apiKey: string) {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setModels([]);
    void fetch(`${MOBILE_API_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(await mobileResponseError(response));
      return textChatModels(await response.json());
    }).then((available) => {
      if (controller.signal.aborted) return;
      if (!available.length) throw new Error("这个 Key 暂无可用的文本模型，请检查 Key 的模型权限");
      setModels(available);
      setModel((current) => {
        let saved = "";
        try { saved = localStorage.getItem(MOBILE_MODEL_STORAGE_KEY) ?? ""; } catch { /* Storage is optional. */ }
        return available.includes(current) ? current : available.includes(saved) ? saved
          : available.includes("gpt-5.6-luna") ? "gpt-5.6-luna" : available[0];
      });
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [apiKey, attempt]);

  const selectModel = (value: string) => {
    if (!models.includes(value)) return;
    setModel(value);
    try { localStorage.setItem(MOBILE_MODEL_STORAGE_KEY, value); } catch { /* Storage is optional. */ }
  };

  return { models, model, selectModel, loading, error, reload: () => setAttempt((value) => value + 1) };
}
