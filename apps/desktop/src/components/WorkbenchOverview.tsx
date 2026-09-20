import { FolderOpen } from "lucide-react";
import { useState } from "react";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { LocalFileTarget } from "../localFiles";
import { PlanProgress } from "./ExecutionActivity";
import { ArtifactCard } from "./TimelineInteractions";
import { RemoteFileBrowser } from "./RemoteFileBrowser";

export function WorkbenchOverview({
  app,
  onOpenFile,
  filesOnly = false,
}: {
  app: MiniqAppController;
  onOpenFile: (target: LocalFileTarget) => void;
  filesOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [browse, setBrowse] = useState(false);
  const artifacts = app.feed.artifacts.filter((file) =>
    `${file.title}\n${file.path}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <section
      className="workbench-overview"
      aria-label={filesOnly ? "会话文件" : "任务概览"}
    >
      <h2>
        {filesOnly
          ? "会话文件"
          : (app.catalog.currentSession?.title ?? "工作面板")}
      </h2>
      {!app.catalog.currentSessionId && (
        <p>打开一个会话后，可以在这里查看任务计划、交付文件和修改内容。</p>
      )}
      {!filesOnly && <PlanProgress plan={app.feed.plan} busy={!!app.busy} />}
      {!filesOnly && !app.feed.plan.length && app.catalog.currentSessionId && (
        <p>本会话尚未记录任务计划。文件、网页和审阅可以随时切换。</p>
      )}
      <h3>交付文件 · {app.feed.artifacts.length}</h3>
      {app.preview.canReopenClosedTab && (
        <button
          type="button"
          className="ghost"
          onClick={app.preview.reopenClosedTab}
        >
          重新打开关闭的文件
        </button>
      )}
      {app.feed.artifacts.length > 0 && (
        <input
          type="search"
          className="workbench-artifact-search"
          aria-label="筛选交付文件"
          placeholder="按文件名、标题或路径筛选"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {artifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.id}
          artifact={artifact}
          workspacePath={
            app.catalog.currentSession?.workingDirectory ??
            app.catalog.currentWorkspace?.path
          }
          workspacePaths={app.catalog.currentWorkspacePaths}
          onOpenFile={onOpenFile}
          onError={app.setError}
        />
      ))}
      {!artifacts.length && (
        <p>
          {query
            ? "没有匹配的交付文件"
            : "生成的交付文件会集中显示在这里，也可以浏览项目文件。"}
        </p>
      )}
      {app.feed.nextCursor && (
        <p>此处列出已加载的交付记录；更早的记录会随会话历史一起加载。</p>
      )}
      {app.catalog.currentSessionId && (
        <>
          <button
            type="button"
            className="ghost"
            aria-expanded={browse}
            onClick={() => setBrowse((value) => !value)}
          >
            <FolderOpen size={16} />
            {browse ? "收起项目文件" : "浏览项目文件"}
          </button>
          {browse && (
            <RemoteFileBrowser
              access={{
                client: app.client,
                sessionId: app.catalog.currentSessionId,
              }}
              label="项目文件"
              onOpen={(path) => onOpenFile({ path, line: null, column: null })}
            />
          )}
        </>
      )}
    </section>
  );
}
