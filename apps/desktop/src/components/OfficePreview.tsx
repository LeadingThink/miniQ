import { useEffect, useRef, useState } from "react";
import { decodeBase64 } from "../previewBinary";
import { usePreviewScroll } from "../previewViewState";
import { acquirePresentationRenderer } from "../presentationRenderer";

type Props = { dataBase64: string; onError: (message: string) => void };

export function DocxPreview(props: Props) {
  return <OfficePreview {...props} kind="docx" />;
}
export function PptxPreview(props: Props) {
  return <OfficePreview {...props} kind="pptx" />;
}

function OfficePreview({
  dataBase64,
  onError,
  kind,
}: Props & { kind: "docx" | "pptx" }) {
  const report = useRef(onError);
  report.current = onError;
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const scroll = usePreviewScroll<HTMLDivElement>(kind, status === "ready");

  useEffect(() => {
    const container = scroll.ref.current;
    if (!container) return;
    let cancelled = false;
    let settled = false;
    let failed = false;
    let dispose: (() => void) | undefined;
    const staging = document.createElement("div");
    const release = () => {
      const cleanup = dispose;
      dispose = undefined;
      cleanup?.();
      staging.replaceChildren();
      staging.remove();
    };
    setStatus("loading");
    container.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "document-loading";
    loading.textContent =
      kind === "docx" ? "正在解析 Word 文档..." : "正在解析演示文稿...";
    container.append(loading);

    // Each parser owns its staging node, so late completions cannot replace a new file.
    const render = async () => {
      const bytes = decodeBase64(dataBase64);
      if (kind === "docx") {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        await renderAsync(bytes, staging, undefined, {
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          useBase64URL: true,
        });
      } else {
        const releaseOwner = await acquirePresentationRenderer();
        dispose = releaseOwner;
        const { init } = await import("pptx-preview");
        if (cancelled) return;
        // ECharts measures attached DOM. Keep pending parses measurable and
        // hidden even when a newer preview takes over the visible container.
        Object.assign(staging.style, {
          position: "fixed",
          left: "0",
          top: "0",
          width: "960px",
          visibility: "hidden",
          pointerEvents: "none",
        });
        staging.setAttribute("aria-hidden", "true");
        document.body.append(staging);
        const preview = init(staging, {
          width: 960,
          height: 540,
          mode: "list",
        });
        dispose = () => {
          try {
            preview.destroy();
          } finally {
            releaseOwner();
          }
        };
        await preview.preview(bytes);
        // Chart initialization is scheduled by the library after preview resolves.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (!cancelled) {
        staging.removeAttribute("style");
        staging.removeAttribute("aria-hidden");
        container.replaceChildren(staging);
        setStatus("ready");
      }
    };
    void render()
      .catch((cause) => {
        failed = true;
        if (!cancelled) {
          container.replaceChildren();
          setStatus("failed");
          report.current(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      })
      .finally(() => {
        settled = true;
        if (cancelled || failed) release();
      });
    return () => {
      cancelled = true;
      container.replaceChildren();
      if (settled) release();
    };
  }, [dataBase64, kind, scroll.ref]);

  return (
    <div
      {...scroll}
      className={`office-preview ${kind}-preview`}
      aria-busy={status === "loading"}
    />
  );
}
