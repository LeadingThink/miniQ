import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryPanel, type MemoryRecord, type MemoryTarget, type MemoryPage } from "../components/MemoryPanel";
import type { RpcClient } from "../rpc";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/interactions.css";

const initial: MemoryRecord[] = Array.from({ length: 26 }, (_, index) => ({
  id: `sample-${index}`, workspaceId: index < 23 ? "sample-project" : null,
  scope: index < 23 ? "workspace" : "global", createdAt: "2026-09-20T08:00:00Z", updatedAt: "2026-09-20T08:00:00Z",
  content: index === 0 ? "用户偏好中文回复。\n保留完整的项目背景与决定，必要时可展开查看全文。\n这些都是测试样例，不包含任何实际用户信息。\n第四行也会完整保留。"
    : index < 23 ? `项目记忆 ${index + 1}：交付前检查构建与用户操作效果。` : `全局记忆 ${index - 22}：使用清晰的中文解释结果。`,
}));

function Fixture() {
  const records = useRef(initial);
  const [workspaceId, setWorkspaceId] = useState<string | null>("sample-project");
  const client = useMemo(() => ({
    call: async (method: string, input: { target: MemoryTarget; query?: string; before?: MemoryPage["nextCursor"]; limit?: number; id?: string; expectedUpdatedAt?: string; expectedContent?: string }) => {
      const inScope = (item: MemoryRecord) => item.scope === input.target.scope && item.workspaceId === (input.target.scope === "workspace" ? input.target.workspaceId : null);
      if (method === "memory.list") {
        const found = records.current.filter((item) => inScope(item) && item.content.includes(input.query ?? ""));
        const start = input.before ? found.findIndex((item) => item.id === input.before?.id) + 1 : 0;
        const entries = found.slice(start, start + (input.limit ?? 20));
        const last = entries.at(-1);
        return { memories: entries, nextCursor: start + entries.length < found.length && last ? { id: last.id, updatedAt: last.updatedAt } : null };
      }
      if (method === "memory.delete") {
        const item = records.current.find((record) => inScope(record) && record.id === input.id && record.updatedAt === input.expectedUpdatedAt && record.content === input.expectedContent);
        if (!item) throw new Error("样例记忆已经变化，请刷新。");
        records.current = records.current.filter((record) => record !== item);
        return { deleted: item.id };
      }
      throw new Error(`不支持 ${method}`);
    },
    onStatus: () => () => {},
  }) as unknown as RpcClient, []);
  return <main style={{ maxWidth: 780, margin: "32px auto", padding: 20 }}>
    <h1>长期记忆管理验收</h1>
    <p>使用 26 条样例，不读取或修改任何真实记忆。</p>
    <button type="button" onClick={() => setWorkspaceId((value) => value ? null : "sample-project")}>{workspaceId ? "关闭项目" : "打开样例项目"}</button>
    <MemoryPanel client={client} workspaceId={workspaceId} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
