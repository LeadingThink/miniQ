import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { WorkbenchResizer } from "./WorkbenchResizer";
import { isMobileLayout, MOBILE_LAYOUT_QUERY } from "../mobileViewport";
import {
  clampWorkbenchWidth,
  DEFAULT_WORKBENCH_WIDTH,
  readWorkbenchWidth,
  workbenchLayout,
  WORKBENCH_WIDTH_STORAGE_KEY,
} from "../workbenchWidth";
import "./WorkbenchPanel.css";

/** Owns layout updates so dragging never rerenders the conversation tree. */
export function WorkbenchPanel({
  children,
  hidden = false,
  expanded = false,
  onRestore,
  onLayoutChange,
}: {
  children: ReactNode;
  hidden?: boolean;
  expanded?: boolean;
  onRestore?: () => void;
  onLayoutChange?: (mode: "mobile" | "split" | "overlay") => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [preferredWidth, setPreferredWidth] = useState(() =>
    readWorkbenchWidth(window.localStorage),
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [space, setSpace] = useState({
    available: window.innerWidth,
    viewport: window.innerWidth,
    mobile: isMobileLayout(),
  });
  useLayoutEffect(() => {
    const app = container.current?.parentElement;
    if (!app) return;
    const sidebar = app.querySelector<HTMLElement>(":scope > .sidebar");
    const measure = () => {
      const available =
        app.clientWidth - (sidebar?.getBoundingClientRect().width ?? 0);
      const viewport = window.innerWidth;
      const mobile = isMobileLayout();
      setSpace((previous) =>
        previous.available === available &&
        previous.viewport === viewport &&
        previous.mobile === mobile
          ? previous
          : { available, viewport, mobile },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(app);
    if (sidebar) observer.observe(sidebar);
    window.addEventListener("resize", measure);
    const media = window.matchMedia?.(MOBILE_LAYOUT_QUERY);
    media?.addEventListener("change", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      media?.removeEventListener("change", measure);
    };
  }, []);
  const layout = workbenchLayout(space.available, space.viewport, space.mobile);
  useEffect(() => onLayoutChange?.(layout.mode), [layout.mode, onLayoutChange]);
  useEffect(() => {
    if (layout.mode === "mobile") setDragWidth(null);
  }, [layout.mode]);
  const width = clampWorkbenchWidth(
    dragWidth ?? preferredWidth,
    layout.min,
    layout.max,
  );
  const commit = (value: number) => {
    setDragWidth(null);
    setPreferredWidth(value);
    window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(value));
  };
  return (
    <div
      ref={container}
      className="workbench-panel"
      data-layout={layout.mode}
      data-expanded={expanded || undefined}
      style={{ width, display: hidden ? "none" : undefined }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onRestore?.();
        }
      }}
    >
      {layout.mode !== "mobile" && !expanded && (
        <WorkbenchResizer
          width={width}
          min={layout.min}
          max={layout.max}
          onResize={setDragWidth}
          onCommit={commit}
          onCancel={() => setDragWidth(null)}
          onReset={() => commit(DEFAULT_WORKBENCH_WIDTH)}
        />
      )}
      {children}
    </div>
  );
}
