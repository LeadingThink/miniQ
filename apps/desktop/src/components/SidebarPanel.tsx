import { useState, type ReactNode } from "react";
import { WorkbenchResizer } from "./WorkbenchResizer";
import "./WorkbenchPanel.css";

const STORAGE_KEY = "miniq.sidebar.width";
const DEFAULT_WIDTH = 264;

/** Keep pointer updates local so the conversation does not rerender on drag. */
export function SidebarPanel({ children }: { children: ReactNode }) {
  const [preferred, setPreferred] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_WIDTH;
    try {
      const value = Number(window.localStorage.getItem(STORAGE_KEY));
      return Number.isFinite(value) && value >= 220 && value <= 420 ? value : DEFAULT_WIDTH;
    } catch { return DEFAULT_WIDTH; }
  });
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const commit = (width: number) => {
    setDragWidth(null);
    setPreferred(width);
    try { window.localStorage.setItem(STORAGE_KEY, String(width)); }
    catch { /* Resizing still works when persistence is unavailable. */ }
  };
  const width = dragWidth ?? preferred;
  return (
    <div className="sidebar" style={{ width }}>
      <WorkbenchResizer
        edge="right"
        label="调整左侧栏宽度"
        width={width}
        min={220}
        max={420}
        onResize={setDragWidth}
        onCommit={commit}
        onCancel={() => setDragWidth(null)}
        onReset={() => commit(DEFAULT_WIDTH)}
      />
      {children}
    </div>
  );
}
