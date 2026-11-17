import { useMemo } from "react";
import type { SessionModelCatalog } from "../sessionModelCatalog";
import type { useSessionModel } from "./useSessionModel";
import type { useZaiwenChat } from "./useZaiwenChat";

/** Supply the original model picker with the cloud catalog and update operation. */
export function useZaiwenModelControls(chat: ReturnType<typeof useZaiwenChat>) {
  const catalog = useMemo<SessionModelCatalog>(() => ({
    list: async () => ({ models: chat.models.map((item) => item.key) }),
    describe: async (model) => ({ model, apiProtocol: "auto", reasoningEfforts: [], maxContextTokens: null, maxOutputTokens: null }),
    defaultModel: chat.models[0]?.key ?? "",
  }), [chat.models]);
  const model: ReturnType<typeof useSessionModel> = {
    settings: { model: chat.model || null, apiProtocol: "auto", reasoningEffort: null },
    effective: chat.model ? { model: chat.model, apiProtocol: "auto", reasoningEffort: null } : null,
    ready: !!chat.model && !!chat.models.length,
    pending: false,
    error: chat.modelError,
    reload: async () => { chat.retryModels(); },
    update: async (settings) => {
      if (chat.busy || !chat.models.some((item) => item.key === settings.model)) throw new Error("当前模型不可用");
      chat.setModel(settings.model!);
    },
  };
  return { catalog, model };
}
