import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerCard } from "../components/Composer";
import { buildModelSlashCommands } from "../modelSlashCommands";
import type { useSessionModel } from "../hooks/useSessionModel";
import type { SessionModelSettings } from "../modelSelection";
import type { RpcClient } from "../rpc";
import type { ComposerSlashCommand } from "../composerSlash";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";

const client = {
  call: async (method: string) => {
    if (method === "skill.list")
      return {
        skills: Array.from({ length: 36 }, (_, index) => ({
          name: index === 0 ? "分析文档与表格" : `项目技能 ${index + 1}`,
          description: "保留完整内容和参数，支持通过描述搜索。".repeat(
            index === 0 ? 5 : 1,
          ),
          enabled: true,
        })),
      };
    if (method === "model.list")
      return { models: ["gpt-5.6-sol", "claude-opus", "gemini-3.8-flash"] };
    if (method === "model.describe")
      return {
        model: "gpt-5.6-sol",
        reasoningEfforts: ["low", "medium", "high"],
      };
    throw new Error(`Unsupported fixture method: ${method}`);
  },
} as unknown as RpcClient;

function Fixture() {
  const [settings, setSettings] = useState<SessionModelSettings>({
    model: "gpt-5.6-sol",
    apiProtocol: "auto",
    reasoningEffort: null,
  });
  const [notice, setNotice] = useState(
    "输入 / 选择命令；也可试 /model、/reasoning、/project",
  );
  const model = {
    settings,
    effective: { ...settings, model: settings.model! },
    ready: true,
    pending: false,
    update: async (value: SessionModelSettings) => {
      setSettings(value);
      setNotice(
        `已切换模型：${value.model}，推理：${value.reasoningEffort ?? "默认"}`,
      );
    },
  } as ReturnType<typeof useSessionModel>;
  const commands: ComposerSlashCommand[] = [
    ...buildModelSlashCommands(client, model, false),
    {
      id: "project",
      name: "切换项目",
      description: "选择项目与独立会话",
      group: "会话",
      icon: "project",
      children: [
        {
          id: "project:a",
          name: "调研项目",
          description: "/work/research",
          group: "项目",
          onSelect: () => setNotice("已选择调研项目"),
        },
        {
          id: "project:b",
          name: "宣传视频",
          description: "/work/video",
          group: "项目",
          onSelect: () => setNotice("已选择宣传视频"),
        },
      ],
    },
    {
      id: "settings",
      name: "打开设置",
      description: "服务、主题与权限",
      group: "设置",
      icon: "settings",
      onSelect: () => setNotice("已打开设置"),
    },
    {
      id: "share",
      name: "分享会话",
      description: "选择消息和文件，预览后创建链接",
      group: "工作流",
      icon: "share",
      onSelect: () => setNotice("已打开分享预览"),
    },
  ];
  return (
    <main
      style={{
        width: "min(760px, calc(100% - 24px))",
        margin: "auto",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        paddingBlock: 20,
        boxSizing: "border-box",
      }}
    >
      <h1 style={{ fontSize: 24 }}>miniQ 快捷命令</h1>
      <p role="status">{notice}</p>
      <div style={{ flex: 1 }} />
      <ComposerCard
        busy={false}
        placeholder="输入 / 选择命令或技能"
        client={client}
        slashCommands={commands}
        workspaceId="fixture"
        onSend={(content) => setNotice(`发送：${content}`)}
        onError={setNotice}
      />
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
