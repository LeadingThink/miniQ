import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  clampPage,
  clampPdfZoom,
  pdfRasterSize,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  PDF_ZOOM_STEP,
} from "../documentPreviewModel";
import { decodeBase64 } from "../previewBinary";
import { PdfSearch } from "./PdfSearch";
import { pdfText, type PdfTextPage } from "../pdfSearch";
import "./PreviewInspectors.css";
import { usePreviewScroll, usePreviewValue } from "../previewViewState";

export function PdfPreview(props: {
  dataBase64: string;
  onError: (message: string) => void;
}) {
  const onError = useRef(props.onError);
  onError.current = props.onError;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PdfDocument | null>(null);
  const [page, setPage] = usePreviewValue("pdfPage", 1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = usePreviewValue("pdfZoom", 1);
  const [fit, setFit] = usePreviewValue("pdfFit", true);
  const [loading, setLoading] = useState(true);
  const [pageText, setPageText] = useState("");
  const [textError, setTextError] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [documentVersion, setDocumentVersion] = useState(0);
  const [showText, setShowText] = usePreviewValue("pdfText", false);
  const stageScroll = usePreviewScroll<HTMLDivElement>(`pdf:${page}`, !loading);
  const renderPromise = useRef<Promise<void>>(Promise.resolve());

  interface PdfViewport {
    width: number;
    height: number;
  }
  interface PdfRenderTask {
    promise: Promise<void>;
    cancel: () => void;
  }
  interface PdfPage extends PdfTextPage {
    getViewport: (options: { scale: number }) => PdfViewport;
    render: (options: {
      canvas: HTMLCanvasElement;
      viewport: PdfViewport;
      transform?: number[];
    }) => PdfRenderTask;
  }
  interface PdfDocument {
    numPages: number;
    getPage: (pageNumber: number) => Promise<PdfPage>;
    destroy: () => Promise<void>;
  }

  useEffect(() => {
    let cancelled = false;
    let documentTask: {
      promise: Promise<PdfDocument>;
      destroy: () => Promise<void>;
    } | null = null;
    let loadedDocument: PdfDocument | null = null;
    setLoading(true);
    setPageCount(0);
    setPageText("");
    setTextError(null);

    void Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ])
      .then(async ([pdfjs, workerModule]) => {
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
        const bytes = new Uint8Array(decodeBase64(props.dataBase64));
        const loadingTask = pdfjs.getDocument({
          data: bytes,
        }) as unknown as typeof documentTask;
        if (!loadingTask) throw new Error("无法创建 PDF 解析任务");
        documentTask = loadingTask;
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        loadedDocument = pdf;
        documentRef.current = pdf;
        setDocumentVersion((value) => value + 1);
        setPageCount(pdf.numPages);
        setPage((current) => clampPage(current, pdf.numPages));
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoading(false);
          onError.current(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      });

    return () => {
      cancelled = true;
      if (documentRef.current === loadedDocument) documentRef.current = null;
      void documentTask?.destroy().catch(() => {});
    };
  }, [props.dataBase64]);

  useEffect(() => {
    const pdf = documentRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || pageCount === 0) return;
    let cancelled = false;
    let renderTask: PdfRenderTask | null = null;
    setLoading(true);
    void pdf
      .getPage(clampPage(page, pageCount))
      .then(async (pdfPage) => {
        try {
          await renderPromise.current.catch(() => {});
          if (cancelled) return;
          const viewport = pdfPage.getViewport({ scale: 1.35 * zoom });
          const raster = pdfRasterSize(
            viewport.width,
            viewport.height,
            window.devicePixelRatio,
          );
          canvas.width = raster.width;
          canvas.height = raster.height;
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          renderTask = pdfPage.render({
            canvas,
            viewport,
            transform:
              raster.ratio === 1
                ? undefined
                : [raster.ratio, 0, 0, raster.ratio, 0, 0],
          });
          renderPromise.current = renderTask.promise;
          await renderTask.promise;
        } finally {
          pdfPage.cleanup?.();
        }
      })
      .then(() => {
        if (!cancelled) setLoading(false);
      })
      .catch((cause) => {
        if (
          !cancelled &&
          cause instanceof Error &&
          cause.name !== "RenderingCancelledException"
        ) {
          setLoading(false);
          onError.current(cause.message);
        }
      });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [documentVersion, page, pageCount, zoom]);

  useEffect(() => {
    const pdf = documentRef.current;
    let cancelled = false;
    setPageText("");
    setTextError(null);
    setTextLoading(Boolean(showText && pdf));
    if (showText && pdf) {
      void pdf
        .getPage(clampPage(page, pageCount))
        .then(async (current) => {
          try {
            if (cancelled) return;
            const text = pdfText((await current.getTextContent()).items);
            if (!cancelled) setPageText(text);
          } finally {
            current.cleanup?.();
          }
        })
        .catch((cause) => {
          if (!cancelled) setTextError(`原文提取失败：${String(cause)}`);
        })
        .finally(() => {
          if (!cancelled) setTextLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [documentVersion, page, pageCount, showText]);

  return (
    <div className="pdf-preview">
      <div className="pdf-toolbar" aria-label="PDF 控制栏">
        <button
          type="button"
          className="icon-button"
          aria-label="上一页"
          title="上一页"
          disabled={page <= 1}
          onClick={() => setPage((value) => clampPage(value - 1, pageCount))}
        >
          <ChevronLeft size={16} />
        </button>
        <label className="pdf-page-input">
          第{" "}
          <input
            aria-label="PDF 页码"
            type="number"
            min={1}
            max={Math.max(pageCount, 1)}
            value={page}
            disabled={!pageCount}
            onChange={(event) => {
              if (Number.isFinite(event.target.valueAsNumber))
                setPage(clampPage(event.target.valueAsNumber, pageCount));
            }}
          />{" "}
          / {Math.max(pageCount, 1)} 页
        </label>
        <button
          type="button"
          className="icon-button"
          aria-label="下一页"
          title="下一页"
          disabled={page >= pageCount}
          onClick={() => setPage((value) => clampPage(value + 1, pageCount))}
        >
          <ChevronRight size={16} />
        </button>
        <span className="pdf-toolbar-separator" />
        <button
          type="button"
          className="icon-button"
          aria-label="缩小 PDF"
          title="缩小"
          disabled={zoom <= PDF_MIN_ZOOM}
          onClick={() => {
            setFit(false);
            setZoom((value) => clampPdfZoom(value - PDF_ZOOM_STEP));
          }}
        >
          <Minus size={15} />
        </button>
        <span>{fit ? "适配" : `${Math.round(zoom * 100)}%`}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="放大 PDF"
          title="放大"
          disabled={zoom >= PDF_MAX_ZOOM}
          onClick={() => {
            setFit(false);
            setZoom((value) => clampPdfZoom(value + PDF_ZOOM_STEP));
          }}
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="重置 PDF 缩放"
          title="重置缩放"
          disabled={zoom === 1 && !fit}
          onClick={() => {
            setFit(false);
            setZoom(1);
          }}
        >
          <RotateCcw size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="适配 PDF 宽度"
          aria-label="适配 PDF 宽度"
          aria-pressed={fit}
          onClick={() => {
            setFit(true);
            setZoom(1);
          }}
        >
          <Maximize size={16} />
        </button>
      </div>
      <PdfSearch
        key={documentVersion}
        document={pageCount ? documentRef.current : null}
        onPage={setPage}
      />
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
          {textLoading
            ? "正在读取原文"
            : textError || pageText || "当前页没有可提取文本"}
        </pre>
      )}
      <div {...stageScroll} className="pdf-stage" aria-busy={loading}>
        {loading && (
          <div className="document-loading">正在渲染第 {page} 页...</div>
        )}
        <section
          className="pdf-page"
          data-fit={fit}
          aria-label={`第 ${page} 页`}
        >
          <canvas ref={canvasRef} />
        </section>
      </div>
    </div>
  );
}
