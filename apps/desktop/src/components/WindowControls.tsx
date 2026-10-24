import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function WindowControls({ onError }: { onError: (message: string) => void }) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const window = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const update = async () => {
      const value = await window.isMaximized();
      if (!disposed) setMaximized(value);
    };
    void update().catch((error) => onError(String(error)));
    void window.onResized(() => { void update().catch((error) => onError(String(error))); })
      .then((off) => { if (disposed) off(); else unlisten = off; })
      .catch((error) => onError(String(error)));
    return () => { disposed = true; unlisten?.(); };
  }, [onError]);
  const run = (action: "minimize" | "toggleMaximize" | "close") => {
    void getCurrentWindow()[action]().catch((error) => onError(`窗口操作失败：${String(error)}`));
  };
  return <div className="window-controls" aria-label="窗口控制">
    <button type="button" aria-label="最小化" title="最小化" onClick={() => run("minimize")}><Minus size={14} /></button>
    <button type="button" aria-label={maximized ? "还原窗口" : "最大化"} title={maximized ? "还原窗口" : "最大化"} onClick={() => run("toggleMaximize")}>
      {maximized ? <Copy size={12} /> : <Square size={12} />}
    </button>
    <button type="button" className="window-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => run("close")}><X size={16} /></button>
  </div>;
}
