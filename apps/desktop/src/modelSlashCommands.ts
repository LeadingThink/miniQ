import type { ComposerSlashCommand } from "./composerSlash";
import type { useSessionModel } from "./hooks/useSessionModel";
import {
  EFFORT_LABELS,
  type ModelDescription,
  type ReasoningEffort,
} from "./modelSelection";
import type { RpcClient } from "./rpc";

export function buildModelSlashCommands(
  client: RpcClient,
  model: ReturnType<typeof useSessionModel>,
  busy: boolean,
): ComposerSlashCommand[] {
  const disabledReason = busy
    ? "当前任务结束后可更换模型和推理强度"
    : model.pending
      ? "正在保存当前会话的模型设置"
      : !model.ready
        ? "请等待当前会话的模型配置加载完成"
        : undefined;
  const availability = { disabled: Boolean(disabledReason), disabledReason };
  const assertReady = () => {
    if (disabledReason) throw new Error(disabledReason);
  };
  const currentModel = model.settings.model ?? model.effective?.model;

  return [
    {
      id: "model",
      name: "切换模型",
      description: currentModel
        ? `当前会话：${currentModel}`
        : "为当前会话选择文本模型",
      group: "会话",
      keywords: ["model", "模型", "切换", "文本"],
      icon: "model",
      ...availability,
      loadChildren: async () => {
        assertReady();
        const { models } = await client.call<{ models: string[] }>(
          "model.list",
        );
        return models.map((id) => ({
          id: `model:${id}`,
          name: id,
          description:
            id === currentModel ? "当前会话模型" : "仅更换当前会话的模型",
          group: "文本模型",
          icon: "model",
          keywords: [id],
          selected: id === currentModel,
          ...availability,
          onSelect: async () => {
            assertReady();
            await model.update({
              model: id,
              apiProtocol: "auto",
              reasoningEffort: null,
            });
          },
        }));
      },
    },
    {
      id: "reasoning",
      name: "调整推理强度",
      description: "选择当前模型支持的推理强度，仅作用于当前会话",
      group: "会话",
      keywords: ["reasoning", "effort", "推理", "思考", "强度"],
      icon: "reasoning",
      ...availability,
      loadChildren: async () => {
        assertReady();
        if (!model.effective)
          throw new Error("当前会话尚未配置可用模型，请先设置 API Key");
        const description = await client.call<ModelDescription>(
          "model.describe",
          {
            model: model.effective.model,
            apiProtocol: model.effective.apiProtocol,
          },
        );
        const efforts: (ReasoningEffort | null)[] = [
          null,
          ...description.reasoningEfforts,
        ];
        return efforts.map((effort) => ({
          id: `reasoning:${effort ?? "default"}`,
          name: effort === null ? "默认推理" : EFFORT_LABELS[effort],
          description:
            effort === null
              ? "使用模型默认的推理设置"
              : `${description.model} · ${EFFORT_LABELS[effort]}推理强度`,
          group: "推理强度",
          icon: "reasoning",
          keywords: [effort ?? "default", "推理"],
          selected: effort === (model.settings.reasoningEffort ?? null),
          ...availability,
          onSelect: async () => {
            assertReady();
            await model.update({
              ...model.settings,
              apiProtocol: "auto",
              reasoningEffort: effort,
            });
          },
        }));
      },
    },
  ];
}
