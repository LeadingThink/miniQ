import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePreviewPanel } from "../components/FilePreviewPanel";
import type { FilePreviewState } from "../hooks/useFilePreview";
import html from "../../../../crates/miniq-daemon/examples/experience_preview.html?raw";
import { pdfFixtureBase64 } from "./pdf";
import { applyTheme } from "../theme";
import previewImage from "../../src-tauri/icons/icon.png?url";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/review.css";
import "../styles/experience.css";

const markdown = `# 预览验收报告\n\n[流程与结果](#流程与结果)\n\n## 流程与结果\n\n| 项目 | 结果 |\n| --- | --- |\n| 模型调用 | 已隔离 |\n| 完整内容 | 已保留 |\n\n\`\`\`mermaid\nflowchart LR\n A[采集数据] --> B{质量检查}\n B -->|通过| C[发布报告]\n B -->|重试| A\n\`\`\`\n\n公式：$E = mc^2$\n\n![miniQ](${new URL(previewImage, location.href).href})\n\n## Checks\n\n\`\`\`md\n# Not a heading\n\`\`\`\n`;
const csv =
  '编号,备注,数值\r\n001,"包含,逗号",123\r\n002,"两行\n完整内容",456\r\n' +
  Array.from(
    { length: 1000 },
    (_, index) => `${index + 3},记录,${index * 7}`,
  ).join("\n");
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="300" viewBox="0 0 800 300"><rect width="800" height="300" fill="white"/><path d="M50 250 L160 180 L270 210 L380 100 L490 140 L600 70 L750 40" fill="none" stroke="#12805c" stroke-width="8"/><text x="50" y="45" font-size="26" fill="#222">miniQ · 趋势图</text></svg>';
const officeSamples = {
  "protected.pdf":
    "https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/issue15893_reduced.pdf",
  "document.docx":
    "https://raw.githubusercontent.com/VolodymyrBaydalka/docxjs/master/tests/render-test/table/document.docx",
  "slides.pptx":
    "https://501351981.github.io/pptx-preview/examples/dist/test.pptx",
};

function Fixture() {
  const [file, setFile] = useState("preview.html");
  const [line, setLine] = useState<number | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const [width, setWidth] = useState("560");
  const [binary, setBinary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBinary(null);
    setError(null);
    if (!(file in officeSamples)) return;
    const controller = new AbortController();
    const reader = new FileReader();
    reader.onload = () => {
      if (!controller.signal.aborted)
        setBinary(String(reader.result).split(",", 2)[1]);
    };
    void fetch(officeSamples[file as keyof typeof officeSamples], {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (!controller.signal.aborted) reader.readAsDataURL(blob);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause));
      });
    return () => {
      controller.abort();
      if (reader.readyState === 1) reader.abort();
    };
  }, [file]);
  const preview: FilePreviewState = {
    target: { path: `/fixture/${file}`, line, column: null },
    resolvedPath: `/fixture/${file}`,
    content: file.endsWith("md")
      ? markdown
      : file.endsWith("csv")
        ? csv
        : file.endsWith("svg")
          ? svg
          : html,
    kind: file.endsWith("md")
      ? "markdown"
      : file.endsWith("pdf")
        ? "pdf"
        : file.endsWith("docx")
          ? "docx"
          : file.endsWith("pptx")
            ? "pptx"
            : "text",
    mimeType: null,
    dataBase64: file === "document.pdf" ? pdfFixtureBase64() : binary,
    size: null,
    loading: file in officeSamples && !binary && !error,
    error,
    open: true,
  };
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{ padding: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select
          aria-label="Test document"
          value={file}
          onChange={(event) => {
            setFile(event.target.value);
            setLine(null);
          }}
        >
          <option>preview.html</option>
          <option>report.md</option>
          <option>data.csv</option>
          <option>chart.svg</option>
          <option>document.pdf</option>
          <option>protected.pdf</option>
          <option>document.docx</option>
          <option>slides.pptx</option>
        </select>
        <select
          aria-label="Preview width"
          value={width}
          onChange={(event) => setWidth(event.target.value)}
        >
          <option value="360">360</option>
          <option value="560">560</option>
          <option value="100%">Full</option>
        </select>
        <label>
          <input
            type="checkbox"
            onChange={(event) => {
              applyTheme(event.target.checked ? "night" : "jade");
            }}
          />
          Dark
        </label>
        <output aria-label="Refresh count">{refreshes}</output>
      </nav>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          width: width === "100%" ? width : Number(width),
          maxWidth: "100%",
          marginLeft: "auto",
        }}
      >
        <FilePreviewPanel
          preview={preview}
          workspacePath="/fixture"
          workspacePaths={["/fixture"]}
          onClose={() => {}}
          onOpenFile={(target) => setLine(target.line)}
          onRetry={() => setRefreshes((value) => value + 1)}
        />
      </div>
    </main>
  );
}

if (import.meta.env.DEV)
  createRoot(document.getElementById("root")!).render(<Fixture />);
