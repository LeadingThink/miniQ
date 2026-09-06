import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePreviewPanel } from "../components/FilePreviewPanel";
import type { FilePreviewState } from "../hooks/useFilePreview";
import html from "../../../../crates/miniq-daemon/examples/experience_preview.html?raw";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/review.css";
import "../styles/experience.css";

const markdown =
  "# Report\n\n[Next section](#checks)\n\n## Checks\n\n| Item | Result |\n| --- | --- |\n| Model | Isolated |\n| Tools | Preserved |\n\n## Checks\n\n```md\n# Not a heading\n```\n";

function Fixture() {
  const [file, setFile] = useState("preview.html");
  const [line, setLine] = useState<number | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const preview: FilePreviewState = {
    target: { path: `/fixture/${file}`, line, column: null },
    resolvedPath: `/fixture/${file}`,
    content: file.endsWith("md") ? markdown : html,
    kind: file.endsWith("md") ? "markdown" : "text",
    mimeType: null,
    dataBase64: null,
    size: null,
    loading: false,
    error: null,
    open: true,
  };
  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <nav style={{ padding: 8, display: "flex", gap: 8 }}>
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
        </select>
        <output aria-label="Refresh count">{refreshes}</output>
      </nav>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <FilePreviewPanel
          preview={preview}
          workspacePath="/fixture"
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
