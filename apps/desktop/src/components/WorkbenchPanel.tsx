import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { WorkbenchResizer } from "./WorkbenchResizer";
import {
  clampWorkbenchWidth,
  DEFAULT_WORKBENCH_WIDTH,
  readWorkbenchWidth,
  workbenchLayout,
  WORKBENCH_WIDTH_STORAGE_KEY,
} from "../workbenchWidth";
import "./WorkbenchPanel.css";

/** Owns layout updates so dragging never rerenders the conversation tree. */
export function WorkbenchPanel({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [preferredWidth, setPreferredWidth] = useState(() =>
    readWorkbenchWidth(window.localStorage),
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [space, setSpace] = useState({
    available: window.innerWidth,
    viewport: window.innerWidth,
  });
  useLayoutEffect(() => {
    const app = container.current?.parentElement;
    if (!app) return;
    const sidebar = app.querySelector<HTMLElement>(":scope > .sidebar");
    const measure = () => {
      const available =
        app.clientWidth - (sidebar?.getBoundingClientRect().width ?? 0);
      const viewport = window.innerWidth;
      setSpace((previous) =>
        previous.available === available && previous.viewport === viewport
          ? previous
          : { available, viewport },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(app);
    if (sidebar) observer.observe(sidebar);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const layout = workbenchLayout(space.available, space.viewport);
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
      style={{ width }}
    >
      {layout.mode !== "mobile" && (
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
