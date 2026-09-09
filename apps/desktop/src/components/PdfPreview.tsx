import { RotateCw, Unlock } from "lucide-react";
import { useRef } from "react";
import { clampPage } from "../documentPreviewModel";
import { PdfSearch } from "./PdfSearch";
import { DocumentControls } from "./DocumentControls";
import { usePreviewScroll, usePreviewValue } from "../previewViewState";
import { usePreviewWidth } from "../hooks/usePreviewWidth";
import { usePdfDocument } from "../hooks/usePdfDocument";
import { usePdfPage } from "../hooks/usePdfPage";
import "./PreviewInspectors.css";
import "./PdfTextLayer.css";

export function PdfPreview(props: {
  dataBase64: string;
  onError: (message: string) => void;
}) {
  const { pdf, password, failed } = usePdfDocument(
    props.dataBase64,
    props.onError,
  );
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [savedPage, setPage] = usePreviewValue("pdfPage", 1);
  const [zoom, setZoom] = usePreviewValue("pdfZoom", 1);
  const [fit, setFit] = usePreviewValue("pdfFit", true);
  const [rotation, setRotation] = usePreviewValue("pdfRotation", 0);
  const [showText, setShowText] = usePreviewValue("pdfText", false);
  const count = pdf?.numPages ?? 0;
  const page = clampPage(savedPage, count);
  const stageRef = useRef<HTMLDivElement>(null);
  const width = usePreviewWidth(stageRef);
  const rendered = usePdfPage({
    pdf,
    page,
    zoom,
    fitWidth: fit ? width : 0,
    rotation,
    canvas,
    textLayer,
    onError: props.onError,
  });
  const loading = !failed && (!pdf || rendered.loading);
  const scroll = usePreviewScroll(
    `pdf:${page}`,
    !loading && Boolean(pdf),
    stageRef,
  );
  return (
    <div className="pdf-preview">
      <DocumentControls
        label="PDF"
        page={page}
        count={count}
        onPage={setPage}
        scale={fit ? rendered.scale : zoom}
        fit={fit}
        onScale={(value) => {
          setFit(false);
          setZoom(value);
        }}
        onFit={() => setFit(true)}
      >
        <button
          type="button"
          className="icon-button"
          title="旋转 PDF"
          aria-label="旋转 PDF"
          disabled={!pdf}
          onClick={() => setRotation((value) => (value + 90) % 360)}
        >
          <RotateCw size={16} />
        </button>
      </DocumentControls>
      <PdfSearch document={pdf} onPage={setPage} />
      <label className="pdf-text-toggle">
        <input
          type="checkbox"
          checked={showText}
          onChange={(event) => setShowText(event.target.checked)}
        />
        原文
      </label>
      {showText && (
        <pre className="pdf-extracted-text" aria-label={`第 ${page} 页原文`}>
          {rendered.loading
            ? "正在读取原文"
            : rendered.text || "当前页没有可提取文本"}
        </pre>
      )}
      <div {...scroll} className="pdf-stage" aria-busy={!password && loading}>
        {password && (
          <form
            className="pdf-password"
            onSubmit={(event) => {
              event.preventDefault();
              const input = event.currentTarget.elements.namedItem(
                "password",
              ) as HTMLInputElement;
              password.submit(input.value);
              input.value = "";
            }}
          >
            <label>
              PDF 密码
              <input
                autoFocus
                name="password"
                type="password"
                required
                autoComplete="off"
              />
            </label>
            {password.incorrect && <span role="alert">密码不正确，请重试</span>}
            <button type="submit">
              <Unlock size={16} />
              解锁
            </button>
          </form>
        )}
        {!password && loading && (
          <div className="document-loading">正在渲染第 {page} 页...</div>
        )}
        <section
          className="pdf-page"
          data-fit={fit}
          aria-label={`第 ${page} 页`}
          style={{ visibility: loading || !pdf ? "hidden" : "visible" }}
        >
          <canvas ref={canvas} aria-hidden="true" />
          <div ref={textLayer} className="pdf-text-layer" />
        </section>
      </div>
    </div>
  );
}
