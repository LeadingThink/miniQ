import { useEffect, useRef, useState, type PointerEvent } from "react";

interface WorkbenchResizerProps {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
}

export function WorkbenchResizer(props: WorkbenchResizerProps) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("workbench-resizing");
    return () => document.body.classList.remove("workbench-resizing");
  }, [dragging]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: props.width };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    props.onResize(start.width + start.x - event.clientX);
  };

  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className={`workbench-resizer ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-label="调整右侧预览区宽度"
      aria-orientation="vertical"
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.width}
      tabIndex={0}
      title="拖动调整预览区宽度；双击恢复默认"
      onDoubleClick={props.onReset}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") props.onResize(props.width + 24);
        else if (event.key === "ArrowRight") props.onResize(props.width - 24);
        else if (event.key === "Home") props.onResize(props.min);
        else if (event.key === "End") props.onResize(props.max);
        else return;
        event.preventDefault();
      }}
    />
  );
}
