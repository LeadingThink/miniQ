import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchPanel } from "../components/WorkbenchPanel";
import { FilePreviewPanel } from "../components/FilePreviewPanel";
import { WorkspaceFileTree } from "../components/WorkspaceFileTree";
import { WorkbenchLauncher } from "../components/WorkbenchLauncher";
import "../components/WorkbenchLauncher.css";
import { Files } from "lucide-react";
import { pdfFixtureBase64 } from "./pdf";
import "../components/WorkbenchToolbar.css";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/review.css";
import "../styles/remote.css";
import "../styles/experience.css";

const TREE: Record<string, [string, boolean][]> = {
  "/fixture": [
    ["docs", true], ["src", true], [".miniq", true], ["report.md", false],
    ["preview.html", false], ["document.pdf", false],
    ["2026-08-01至2026-08-31收支记录汇总.xlsx", false],
    ["download_mindshow_themes.py", false], ["微信图片20260801183245.png", false],
    ["archive.zip", false], ["rewrite.log", false],
  ],
  "/fixture/docs": [["guide.md", false], ["api", true]],
  "/fixture/docs/api": [["v2", true]],
  "/fixture/docs/api/v2": [["guide.md", false]],
  "/fixture/src": [["main.rs", false], ["lib10.rs", false], ["lib2.rs", false]],
};
const treeClient = {
  mode: "local",
  call: async (_method: string, params: { path: string }) => {
    const path = params.path || "/fixture";
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      path, parent: null, roots: ["/fixture"], nextCursor: null,
      entries: (TREE[path] ?? []).map(([name, directory]) => ({
        name, path: `${path}/${name}`, directory, size: 1024,
      })),
    };
  },
} as never;

function Fixture() {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(true);
  const [file, setFile] = useState("report.md");
  const [empty, setEmpty] = useState(false);
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);
  const markdown =
    "# 分栏交互验收\n\n拖动左侧边界调整宽度。缩小窗口、开合侧栏后，仍记住主动设置的宽度。\n\n| 验收点 | 预期 |\n|---|---|\n| 双向拖动 | 即时跟随 |\n| 小窗口 | 拖动条可用 |\n| 状态 | 不重新加载 |\n\n## 完整内容\n\n" +
    Array.from(
      { length: 30 },
      (_, i) => `段落 ${i + 1}：预览内容不会因为调整宽度而丢失。`,
    ).join("\n\n");
  const html =
    '<!doctype html><html lang="zh-CN"><body><h1>交互内容状态</h1><button onclick="this.textContent=Number(this.textContent)+1">0</button><input aria-label="草稿" placeholder="拖动后保留输入" /></body></html>';
  return (
    <div className={`app ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <strong>miniQ 预览验收</strong>
        <p>实际生产分栏组件</p>
      </aside>
      <main className="main">
        <nav style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button onClick={() => setCollapsed(!collapsed)}>切换侧栏</button>
          <button onClick={() => setOpen(true)}>打开预览</button>
          <button onClick={() => setEmpty(!empty)}>切换空面板</button>
          <select
            aria-label="验收文件"
            value={file}
            onChange={(event) => {
              setFile(event.target.value);
              setOpen(true);
            }}
          >
            <option>report.md</option>
            <option>preview.html</option>
            <option>document.pdf</option>
            <option>docs/api/v2/guide.md</option>
          </select>
        </nav>
        <section style={{ padding: 24 }}>
          <h1>会话区域</h1>
          <p>保留足够阅读空间，窄窗口自动浮层，手机全屏预览。</p>
          <textarea aria-label="会话草稿" placeholder="调整宽度时保留草稿" />
        </section>
      </main>
      {open && (
        <WorkbenchPanel>
          <div className="workbench-content">
          <div className="workbench-files with-tree">
          <div className="workbench-files-main">
          {empty ? (
            <section className="workbench-overview workbench-empty" aria-label="会话文件">
              <Files size={26} strokeWidth={1.6} aria-hidden />
              <h2>打开文件</h2>
              <p>从右侧文件树选择文件，或按快捷键快速筛选</p>
              <WorkbenchLauncher
                actions={{ onOpenFiles: () => {}, onOpenBrowser: () => {}, onOpenReview: () => {}, changes: 3, onOpenTerminal: () => {} }}
              />
            </section>
          ) : (
          <FilePreviewPanel
            workspacePath="/fixture"
            workspacePaths={["/fixture"]}
            preview={{
              target: { path: `/fixture/${file}`, line: null, column: null },
              resolvedPath: `/fixture/${file}`,
              open: true,
              loading: false,
              error: null,
              mimeType: null,
              size: null,
              content: file.endsWith("md") ? markdown : html,
              kind: file.endsWith("pdf")
                ? "pdf"
                : file.endsWith("md")
                  ? "markdown"
                  : "text",
              dataBase64: file.endsWith("pdf") ? pdfFixtureBase64() : null,
            }}
            onClose={() => setOpen(false)}
            onOpenFile={() => {}}
            onRetry={() => {}}
            onRevealDirectory={(path) => setReveal({ path, nonce: Date.now() })}
          />
          )}
          </div>
          <aside className="workbench-file-tree-pane" aria-label="项目文件">
            <WorkspaceFileTree
              access={{ client: treeClient, sessionId: "fixture" }}
              activePath={`/fixture/${file}`}
              reveal={reveal}
              onOpen={(path) => {
                setFile(path.replace("/fixture/", ""));
                setOpen(true);
              }}
            />
          </aside>
          </div>
          </div>
        </WorkbenchPanel>
      )}
    </div>
  );
}

if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<Fixture />);
