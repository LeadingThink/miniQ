import { useLayoutEffect, useState, type RefObject } from "react";
import { usePreviewValue } from "../previewViewState";
import { usePreviewWidth } from "./usePreviewWidth";

export function useOfficeLayout(
  ref: RefObject<HTMLDivElement>,
  ready: boolean,
  kind: "docx" | "pptx",
) {
  const [page, setPage] = usePreviewValue(`${kind}Page`, 1);
  const [zoom, setZoom] = usePreviewValue(`${kind}Zoom`, 1);
  const [fit, setFit] = usePreviewValue(`${kind}Fit`, true);
  const [pages, setPages] = useState<HTMLElement[]>([]);
  const [naturalWidth, setNaturalWidth] = useState(0);
  const width = usePreviewWidth(ref);
  const scale = fit && width && naturalWidth ? width / naturalWidth : zoom;
  useLayoutEffect(() => {
    const stage = ref.current;
    if (!stage || !ready) {
      setPages([]);
      return;
    }
    const content = stage.firstElementChild as HTMLElement | null;
    if (!content) return;
    const items = Array.from(
      content.querySelectorAll<HTMLElement>(
        kind === "docx" ? "section.docx" : ".pptx-preview-slide-wrapper",
      ),
    );
    setPages(items);
    content.classList.add("office-document");
    items.forEach((item, index) => {
      item.setAttribute("aria-label", `第 ${index + 1} 页`);
      item.setAttribute("role", "region");
    });
    const measure = () => setNaturalWidth(content.offsetWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [ref, ready, kind]);
  useLayoutEffect(() => {
    const content = ref.current?.firstElementChild as HTMLElement | null;
    if (ready && content) content.style.zoom = String(scale);
  }, [ref, ready, scale]);
  const onPage = (value: number) => {
    const next = Math.max(1, Math.min(pages.length, value));
    pages[next - 1]?.scrollIntoView({ block: "start", inline: "nearest" });
    setPage(next);
  };
  const onScroll = () => {
    const stage = ref.current;
    if (!stage || !pages.length) return;
    const viewport = stage.getBoundingClientRect();
    let active = 0;
    let mostVisible = -1;
    pages.forEach((item, index) => {
      const bounds = item.getBoundingClientRect();
      const visible = Math.max(
        0,
        Math.min(bounds.bottom, viewport.bottom) -
          Math.max(bounds.top, viewport.top),
      );
      if (visible > mostVisible) {
        mostVisible = visible;
        active = index;
      }
    });
    setPage(active + 1);
  };
  return {
    page: Math.min(page, Math.max(1, pages.length)),
    count: pages.length,
    scale,
    fit,
    onPage,
    onScroll,
    onScale: (value: number) => {
      setFit(false);
      setZoom(value);
    },
    onFit: () => setFit(true),
  };
}
