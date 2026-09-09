import { useEffect, useRef, useState, type RefObject } from "react";
import type { PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import { pdfRasterSize } from "../documentPreviewModel";
import { pdfText } from "../pdfSearch";
import { loadPdfRuntime } from "../pdfRuntime";

export function usePdfPage(props: {
  pdf: PDFDocumentProxy | null;
  page: number;
  zoom: number;
  fitWidth: number;
  rotation: number;
  canvas: RefObject<HTMLCanvasElement>;
  textLayer: RefObject<HTMLDivElement>;
  onError: (message: string) => void;
}) {
  const { pdf, page, zoom, fitWidth, rotation, canvas, textLayer } = props;
  const report = useRef(props.onError);
  report.current = props.onError;
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const [state, setState] = useState({ loading: true, text: "", scale: zoom });
  useEffect(() => {
    const canvasElement = canvas.current;
    const textElement = textLayer.current;
    if (!pdf || !canvasElement || !textElement) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let layer: TextLayer | undefined;
    setState((value) => ({ ...value, loading: true, text: "" }));
    const previous = pending.current;
    const render = async () => {
      await previous.catch(() => {});
      if (cancelled) return;
      const current = await pdf.getPage(page);
      try {
        if (cancelled) return;
        const angle = ((current.rotate ?? 0) + rotation) % 360;
        const natural = current.getViewport({ scale: 1, rotation: angle });
        const scale = fitWidth > 0 ? fitWidth / natural.width : zoom;
        const viewport = current.getViewport({ scale, rotation: angle });
        const raster = pdfRasterSize(
          viewport.width,
          viewport.height,
          window.devicePixelRatio,
        );
        canvasElement.width = raster.width;
        canvasElement.height = raster.height;
        canvasElement.style.width = `${viewport.width}px`;
        canvasElement.style.height = `${viewport.height}px`;
        textElement.replaceChildren();
        textElement.style.setProperty("--total-scale-factor", String(scale));
        renderTask = current.render({
          canvas: canvasElement,
          viewport,
          transform:
            raster.ratio === 1
              ? undefined
              : [raster.ratio, 0, 0, raster.ratio, 0, 0],
        });
        await renderTask.promise;
        if (cancelled) return;
        const content = await current.getTextContent();
        const { TextLayer } = await loadPdfRuntime();
        if (cancelled) return;
        layer = new TextLayer({
          textContentSource: content,
          container: textElement,
          viewport,
        });
        await layer.render();
        if (!cancelled)
          setState({ loading: false, text: pdfText(content.items), scale });
      } finally {
        current.cleanup();
      }
    };
    pending.current = render().catch((error) => {
      if (!cancelled) {
        setState((value) => ({ ...value, loading: false }));
        report.current(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, zoom, fitWidth, rotation, canvas, textLayer]);
  return state;
}
