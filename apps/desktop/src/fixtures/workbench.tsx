import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchPanel } from "../components/WorkbenchPanel";
import { FilePreviewPanel } from "../components/FilePreviewPanel";
import { pdfFixtureBase64 } from "./pdf";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/review.css";
import "../styles/remote.css";
import "../styles/experience.css";

function Fixture() {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(true);
  const [file, setFile] = useState("report.md");
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
          <FilePreviewPanel
            workspacePath="/fixture"
            workspacePaths={["/fixture"]}
            preview={{
              target: { path: file, line: null, column: null },
              resolvedPath: file,
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
          />
        </WorkbenchPanel>
      )}
    </div>
  );
}

if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<Fixture />);
