import { RotateCw, Unlock } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  clampPage,
  pdfLayout,
  pdfPageAt,
  pdfVisibleRange,
  type PdfLayout,
  type PdfPageSize,
} from "../documentPreviewModel";
import { PdfSearch } from "./PdfSearch";
import { DocumentControls } from "./DocumentControls";
import { usePreviewCache, usePreviewValue } from "../previewViewState";
import { usePreviewWidth } from "../hooks/usePreviewWidth";
import { usePdfDocument } from "../hooks/usePdfDocument";
import { usePdfPage } from "../hooks/usePdfPage";
import { pdfText } from "../pdfSearch";
import "./PreviewInspectors.css";
import "./PdfTextLayer.css";

/** Pages kept mounted around the viewport; everything else is an empty spacer. */
const MAX_MOUNTED_PAGES = 10;

type Anchor = { page: number; fraction: number; left: number };

export function PdfPreview(props: {
  dataBase64: string;
  onError: (message: string) => void;
}) {
  const { pdf, password, failed } = usePdfDocument(
    props.dataBase64,
    props.onError,
  );
  const cache = usePreviewCache();
  const [savedPage, setPage] = usePreviewValue("pdfPage", 1);
  const [zoom, setZoom] = usePreviewValue("pdfZoom", 1);
  const [fit, setFit] = usePreviewValue("pdfFit", true);
  const [rotation, setRotation] = usePreviewValue("pdfRotation", 0);
  const [showText, setShowText] = usePreviewValue("pdfText", false);
  const count = pdf?.numPages ?? 0;
  const page = clampPage(savedPage, count);
  const stageRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const width = usePreviewWidth(stageRef);
  const fitWidth = fit ? width : 0;
  const sizes = usePageSizes(pdf, rotation, props.onError);
  const scaleOf = useCallback(
    (natural: PdfPageSize) =>
      fitWidth > 0 ? fitWidth / natural.width : zoom,
    [fitWidth, zoom],
  );
  const layout = useMemo<PdfLayout | null>(() => {
    if (!count || !sizes.fallback) return null;
    const naturals: PdfPageSize[] = [];
    for (let index = 1; index <= count; index += 1)
      naturals.push(sizes.measured.get(index) ?? sizes.fallback);
    return pdfLayout(naturals, scaleOf);
  }, [count, sizes, scaleOf]);
  const [range, setRange] = useState<[number, number]>([page, page]);
  const rangeRef = useRef(range);
  const anchorKey = "pdfAnchor";
  const anchor = () =>
    (cache.get(anchorKey) as Anchor | undefined) ?? {
      page,
      fraction: 0,
      left: 0,
    };

  const origin = () => pagesRef.current?.offsetTop ?? 0;
  const syncRange = useCallback(
    (current: PdfLayout, focus?: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const top = stage.scrollTop - origin();
      const height = stage.clientHeight;
      let [first, last] = pdfVisibleRange(
        current,
        top - height / 2,
        top + height * 1.5,
      );
      if (focus) {
        first = Math.min(first, focus);
        last = Math.max(last, focus);
      }
      if (last - first + 1 > MAX_MOUNTED_PAGES) {
        const center = focus ?? pdfPageAt(current, top + height / 2);
        first = Math.max(first, center - Math.floor(MAX_MOUNTED_PAGES / 2));
        last = Math.min(last, first + MAX_MOUNTED_PAGES - 1);
      }
      // Compare against a ref so an unchanged range never dispatches: a
      // no-op dispatch still re-renders and replays pending size updates.
      const known = rangeRef.current;
      if (known[0] === first && known[1] === last) return;
      rangeRef.current = [first, last];
      setRange([first, last]);
    },
    // origin reads a ref; stable by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Keep the reading position stable whenever page geometry changes
  // (zoom, fit width, rotation, or a real page size replacing the estimate).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!layout || !stage) return;
    const current = anchor();
    const target = clampPage(current.page, count);
    const index = target - 1;
    stage.scrollTop =
      origin() +
      layout.offsets[index] +
      current.fraction * layout.sizes[index].height;
    stage.scrollLeft = current.left;
    syncRange(layout, target);
    // anchor is read from the cache on purpose, not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, count, syncRange]);

  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const onScroll = () => {
    if (!layout) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const stage = stageRef.current;
      if (!stage) return;
      const top = stage.scrollTop - origin();
      const probe = top + Math.min(stage.clientHeight / 4, 160);
      let current = pdfPageAt(layout, Math.max(0, probe));
      if (
        top > 0 &&
        stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2
      )
        current = count;
      const index = pdfPageAt(layout, Math.max(0, top)) - 1;
      cache.set(anchorKey, {
        page: index + 1,
        fraction: Math.max(
          0,
          (top - layout.offsets[index]) / layout.sizes[index].height,
        ),
        left: stage.scrollLeft,
      } satisfies Anchor);
      if (current !== page) setPage(current);
      syncRange(layout);
    });
  };

  const goTo = (value: number) => {
    const target = clampPage(value, count);
    cache.set(anchorKey, { page: target, fraction: 0, left: 0 });
    setPage(target);
    const stage = stageRef.current;
    if (!layout || !stage) return;
    stage.scrollTop = origin() + layout.offsets[target - 1];
    syncRange(layout, target);
  };

  const texts = useRef(new Map<number, string>());
  const [textVersion, setTextVersion] = useState(0);
  const onText = useCallback((index: number, text: string) => {
    if (texts.current.get(index) === text) return;
    texts.current.set(index, text);
    setTextVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    texts.current = new Map();
  }, [pdf]);
  useEffect(() => {
    if (!showText || !pdf || texts.current.has(page)) return;
    let cancelled = false;
    void pdf
      .getPage(page)
      .then((current) => current.getTextContent())
      .then((content) => {
        if (!cancelled) onText(page, pdfText(content.items));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showText, pdf, page, onText, textVersion]);
  const currentText = texts.current.get(page);

  const loading = !failed && Boolean(pdf || !password) && !layout;
  const currentSize = sizes.measured.get(page) ?? sizes.fallback;
  const pages = [];
  if (pdf && layout)
    for (let index = range[0]; index <= Math.min(range[1], count); index += 1)
      pages.push(
        <PdfPageView
          key={index}
          pdf={pdf}
          page={index}
          zoom={zoom}
          fitWidth={fitWidth}
          rotation={rotation}
          fit={fit}
          top={layout.offsets[index - 1]}
          left={(layout.maxWidth - layout.sizes[index - 1].width) / 2}
          width={layout.sizes[index - 1].width}
          height={layout.sizes[index - 1].height}
          onMeasure={sizes.measure}
          onText={onText}
          onError={props.onError}
        />,
      );
  return (
    <div className="pdf-preview">
      <DocumentControls
        label="PDF"
        page={page}
        count={count}
        onPage={goTo}
        scale={fit && currentSize ? scaleOf(currentSize) : zoom}
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
      <PdfSearch document={pdf} onPage={goTo} />
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
          {currentText === undefined
            ? "正在读取原文"
            : currentText || "当前页没有可提取文本"}
        </pre>
      )}
      <div
        ref={stageRef}
        onScroll={onScroll}
        className="pdf-stage"
        data-pinch-zoom="true"
        aria-busy={!password && loading}
      >
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
          <div className="document-loading">正在打开 PDF...</div>
        )}
        <div
          ref={pagesRef}
          className="pdf-pages"
          style={{
            width: layout ? `${layout.maxWidth}px` : undefined,
            height: layout ? `${layout.total}px` : undefined,
          }}
        >
          {pages}
        </div>
      </div>
    </div>
  );
}

/** Real page sizes as they become known; one page's size estimates the rest. */
function usePageSizes(
  pdf: PDFDocumentProxy | null,
  rotation: number,
  onError: (message: string) => void,
) {
  const report = useRef(onError);
  report.current = onError;
  const [state, setState] = useState<{
    key: string;
    fallback: PdfPageSize | null;
    measured: Map<number, PdfPageSize>;
  }>({ key: "", fallback: null, measured: new Map() });
  const key = `${rotation}`;
  useEffect(() => {
    setState({ key, fallback: null, measured: new Map() });
    if (!pdf) return;
    let cancelled = false;
    void pdf
      .getPage(1)
      .then((first) => {
        if (cancelled) return;
        const angle = ((first.rotate ?? 0) + rotation) % 360;
        const natural = first.getViewport({ scale: 1, rotation: angle });
        const size = { width: natural.width, height: natural.height };
        setState((value) => ({
          ...value,
          fallback: size,
          measured: new Map(value.measured).set(1, size),
        }));
      })
      .catch((error) => {
        if (!cancelled)
          report.current(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [pdf, rotation, key]);
  const known = useRef(new Map<number, PdfPageSize>());
  known.current = state.key === key ? state.measured : known.current;
  const measure = useCallback((page: number, size: PdfPageSize) => {
    const seen = known.current.get(page);
    if (seen && seen.width === size.width && seen.height === size.height)
      return;
    setState((value) => {
      const known = value.measured.get(page);
      if (known && known.width === size.width && known.height === size.height)
        return value;
      return {
        ...value,
        fallback: value.fallback ?? size,
        measured: new Map(value.measured).set(page, size),
      };
    });
  }, []);
  return useMemo(
    () => ({
      fallback: state.key === key ? state.fallback : null,
      measured: state.key === key ? state.measured : new Map(),
      measure,
    }),
    [state, key, measure],
  );
}

const PdfPageView = memo(function PdfPageView(props: {
  pdf: PDFDocumentProxy;
  page: number;
  zoom: number;
  fitWidth: number;
  rotation: number;
  fit: boolean;
  top: number;
  left: number;
  width: number;
  height: number;
  onMeasure: (page: number, size: PdfPageSize) => void;
  onText: (page: number, text: string) => void;
  onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const rendered = usePdfPage({
    pdf: props.pdf,
    page: props.page,
    zoom: props.zoom,
    fitWidth: props.fitWidth,
    rotation: props.rotation,
    canvas,
    textLayer,
    onError: props.onError,
    onMeasure: props.onMeasure,
    onText: props.onText,
  });
  return (
    <section
      className="pdf-page"
      data-fit={props.fit}
      data-page={props.page}
      aria-label={`第 ${props.page} 页`}
      aria-busy={rendered.loading}
      style={{
        top: `${props.top}px`,
        left: `${props.left}px`,
        width: `${props.width}px`,
        height: `${props.height}px`,
      }}
    >
      <canvas
        ref={canvas}
        aria-hidden="true"
        style={{ visibility: rendered.loading ? "hidden" : "visible" }}
      />
      <div ref={textLayer} className="pdf-text-layer" />
      {rendered.loading && (
        <span className="pdf-page-loading" aria-hidden="true">
          {props.page}
        </span>
      )}
    </section>
  );
});
