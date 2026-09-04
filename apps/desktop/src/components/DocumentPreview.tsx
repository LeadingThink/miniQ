import {
  ChevronLeft,
  ChevronRight,
  FileWarning,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  clampPage,
  clampPdfZoom,
  moveTabIndex,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  PDF_ZOOM_STEP,
  spreadsheetColumnLabel,
  spreadsheetRow,
} from "../documentPreviewModel";

function decodeBase64(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function BlobPreview(props: {
  dataBase64: string;
  mimeType: string;
  kind: "image" | "audio" | "video";
  label: string;
  onError: (message: string) => void;
}) {
  const url = useMemo(() => {
    const blob = new Blob([decodeBase64(props.dataBase64)], { type: props.mimeType });
    return URL.createObjectURL(blob);
  }, [props.dataBase64, props.mimeType]);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  if (props.kind === "image") {
    return (
      <div className="media-preview">
        <img src={url} alt={props.label || "图片预览"} onError={() => props.onError("图片解码失败")} />
      </div>
    );
  }
  if (props.kind === "audio") {
    return (
      <div className="media-preview">
        <audio src={url} controls preload="metadata" onError={() => props.onError("音频解码失败")} />
      </div>
    );
  }
  return (
    <div className="media-preview">
      <video src={url} controls preload="metadata" onError={() => props.onError("视频解码失败")} />
    </div>
  );
}

export function PdfPreview(props: {
  dataBase64: string;
  onError: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);

  interface PdfViewport { width: number; height: number }
  interface PdfRenderTask { promise: Promise<void>; cancel: () => void }
  interface PdfPage {
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
    let documentTask: { promise: Promise<PdfDocument>; destroy: () => Promise<void> } | null = null;
    let loadedDocument: PdfDocument | null = null;
    setLoading(true);
    setPage(1);
    setPageCount(0);
    setZoom(1);

    void Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
    ])
      .then(async ([pdfjs, workerModule]) => {
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = workerModule.default;
        const bytes = new Uint8Array(decodeBase64(props.dataBase64));
        const loadingTask = pdfjs.getDocument({ data: bytes }) as unknown as typeof documentTask;
        if (!loadingTask) throw new Error("无法创建 PDF 解析任务");
        documentTask = loadingTask;
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        loadedDocument = pdf;
        documentRef.current = pdf;
        setPageCount(pdf.numPages);
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoading(false);
          props.onError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    return () => {
      cancelled = true;
      if (documentRef.current === loadedDocument) documentRef.current = null;
      void documentTask?.destroy();
    };
  }, [props.dataBase64, props.onError]);

  useEffect(() => {
    const pdf = documentRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || pageCount === 0) return;
    let cancelled = false;
    let renderTask: PdfRenderTask | null = null;
    setLoading(true);
    void pdf.getPage(clampPage(page, pageCount)).then((pdfPage) => {
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale: 1.35 * zoom });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      renderTask = pdfPage.render({
        canvas,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      return renderTask.promise;
    }).then(() => {
      if (!cancelled) setLoading(false);
    }).catch((cause) => {
      if (!cancelled && cause instanceof Error && cause.name !== "RenderingCancelledException") {
        setLoading(false);
        props.onError(cause.message);
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [page, pageCount, props.onError, zoom]);

  return (
    <div className="pdf-preview">
      <div className="pdf-toolbar" aria-label="PDF 控制栏">
        <button type="button" className="icon-button" aria-label="上一页" title="上一页" disabled={page <= 1} onClick={() => setPage((value) => clampPage(value - 1, pageCount))}>
          <ChevronLeft size={16} />
        </button>
        <span>第 {page} / {Math.max(pageCount, 1)} 页</span>
        <button type="button" className="icon-button" aria-label="下一页" title="下一页" disabled={page >= pageCount} onClick={() => setPage((value) => clampPage(value + 1, pageCount))}>
          <ChevronRight size={16} />
        </button>
        <span className="pdf-toolbar-separator" />
        <button type="button" className="icon-button" aria-label="缩小 PDF" title="缩小" disabled={zoom <= PDF_MIN_ZOOM} onClick={() => setZoom((value) => clampPdfZoom(value - PDF_ZOOM_STEP))}>
          <Minus size={15} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" className="icon-button" aria-label="放大 PDF" title="放大" disabled={zoom >= PDF_MAX_ZOOM} onClick={() => setZoom((value) => clampPdfZoom(value + PDF_ZOOM_STEP))}>
          <Plus size={15} />
        </button>
        <button type="button" className="icon-button" aria-label="重置 PDF 缩放" title="重置缩放" disabled={zoom === 1} onClick={() => setZoom(1)}>
          <RotateCcw size={14} />
        </button>
      </div>
      <div className="pdf-stage" aria-busy={loading}>
        {loading && <div className="document-loading">正在渲染第 {page} 页...</div>}
        <section className="pdf-page" aria-label={`第 ${page} 页`}>
          <canvas ref={canvasRef} />
        </section>
      </div>
    </div>
  );
}

export function DocxPreview(props: { dataBase64: string; onError: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "document-loading";
    loading.textContent = "正在解析 Word 文档...";
    container.append(loading);
    void import("docx-preview")
      .then(({ renderAsync }) => {
        if (cancelled) return;
        container.replaceChildren();
        return renderAsync(decodeBase64(props.dataBase64), container, undefined, {
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          useBase64URL: true,
        });
      })
      .catch((cause) => {
        if (!cancelled) {
          container.replaceChildren();
          props.onError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [props.dataBase64, props.onError]);

  return <div ref={containerRef} className="office-preview docx-preview" />;
}

export function PptxPreview(props: { dataBase64: string; onError: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "document-loading";
    loading.textContent = "正在解析演示文稿...";
    container.append(loading);
    void import("pptx-preview")
      .then(({ init }) => {
        if (cancelled) return;
        container.replaceChildren();
        return init(container, { width: 960, height: 540, mode: "list" }).preview(
          decodeBase64(props.dataBase64),
        );
      })
      .catch((cause) => {
        if (!cancelled) {
          container.replaceChildren();
          props.onError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [props.dataBase64, props.onError]);

  return <div ref={containerRef} className="office-preview pptx-preview" />;
}

type Cell = string | number | boolean | Date | null;
type Sheet = { sheet: string; data: Cell[][] };
const ROWS_PER_PAGE = 200;

export function SpreadsheetPreview(props: {
  dataBase64: string;
  onError: (message: string) => void;
}) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSheets([]);
    void import("read-excel-file/browser")
      .then(({ default: readXlsxFile }) => readXlsxFile(new Blob([decodeBase64(props.dataBase64)])))
      .then((result) => {
        if (!cancelled) {
          setSheets(result as Sheet[]);
          setSheetIndex(0);
          setPage(0);
          setLoading(false);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoading(false);
          props.onError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => { cancelled = true; };
  }, [props.dataBase64, props.onError]);

  const sheet = sheets[sheetIndex];
  if (loading) return <div className="diff-empty">正在解析工作簿...</div>;
  if (!sheet) return <div className="unsupported-preview"><FileWarning size={28} /><strong>工作簿中没有可显示的工作表</strong></div>;
  const pageCount = Math.max(1, Math.ceil(sheet.data.length / ROWS_PER_PAGE));
  const rows = sheet.data.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);
  const columnCount = sheet.data.reduce((maximum, row) => Math.max(maximum, row.length), 0);

  return (
    <div className="spreadsheet-preview" aria-busy={loading}>
      <div className="sheet-tabs" role="tablist">
        {sheets.map((item, index) => (
          <button
            key={`${item.sheet}-${index}`}
            id={`sheet-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={index === sheetIndex}
            aria-controls="sheet-table"
            tabIndex={index === sheetIndex ? 0 : -1}
            className={index === sheetIndex ? "selected" : ""}
            onClick={() => { setSheetIndex(index); setPage(0); }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = moveTabIndex(sheetIndex, sheets.length, event.key === "ArrowLeft" ? -1 : 1);
              setSheetIndex(next);
              setPage(0);
              document.getElementById(`sheet-tab-${next}`)?.focus();
            }}
          >
            {item.sheet}
          </button>
        ))}
      </div>
      <div id="sheet-table" className="sheet-table-wrap" role="tabpanel" aria-labelledby={`sheet-tab-${sheetIndex}`}>
        {sheet.data.length === 0 ? (
          <div className="diff-empty">当前工作表为空</div>
        ) : (
        <table>
          <thead>
            <tr>
              <th aria-label="行号" />
              {Array.from({ length: columnCount }, (_, index) => <th key={index}>{spreadsheetColumnLabel(index)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={page * ROWS_PER_PAGE + rowIndex}>
                <th>{page * ROWS_PER_PAGE + rowIndex + 1}</th>
                {spreadsheetRow(row, columnCount).map((cell, cellIndex) => (
                  <td key={cellIndex} title={cell instanceof Date ? cell.toLocaleString() : String(cell ?? "")}>{cell instanceof Date ? cell.toLocaleString() : String(cell ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>
      {pageCount > 1 && (
        <div className="sheet-pagination">
          <button type="button" className="icon-button" aria-label="上一页" title="上一页" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
            <ChevronLeft size={16} />
          </button>
          <span>第 {page + 1} / {pageCount} 页 · 共 {sheet.data.length} 行</span>
          <button type="button" className="icon-button" aria-label="下一页" title="下一页" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export function UnsupportedPreview() {
  return (
    <div className="unsupported-preview">
      <FileWarning size={32} />
      <strong>暂不支持内嵌预览此格式</strong>
      <span>可以使用右上角按钮在系统默认应用中打开。</span>
    </div>
  );
}
