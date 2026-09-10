import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clampWorkbenchWidth } from "../workbenchWidth";

interface WorkbenchResizerProps {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
  onCancel: () => void;
  onReset: () => void;
}

/** Window listeners keep dragging across iframe edges and outside the handle. */
function captureDrag(
  event: ReactPointerEvent<HTMLDivElement>,
  current: { current: WorkbenchResizerProps },
  onEnd: () => void,
) {
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  let x = event.clientX;
  let width = current.current.width;
  let frame = 0;
  let moved = false;
  const update = (event: PointerEvent) => {
    moved ||= event.clientX !== x;
    // Rebase at the bounds so reversing direction responds immediately.
    // Keep fractional pointer deltas; rounding each event accumulates drift.
    width = Math.min(
      Math.max(width + x - event.clientX, current.current.min),
      current.current.max,
    );
    x = event.clientX;
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    update(event);
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        current.current.onResize(Math.round(width));
      });
  };
  const cleanup = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", cancelPointer);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", key, true);
    handle.removeEventListener("lostpointercapture", cancelPointer);
    document.body.classList.remove("workbench-resizing");
    if (handle.hasPointerCapture(pointerId))
      handle.releasePointerCapture(pointerId);
  };
  const cancel = () => {
    cleanup();
    current.current.onCancel();
    onEnd();
  };
  const cancelPointer = (event: PointerEvent) => {
    if (event.pointerId === pointerId) cancel();
  };
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    update(event);
    cleanup();
    if (moved) current.current.onCommit(Math.round(width));
    else current.current.onCancel();
    onEnd();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  handle.setPointerCapture(pointerId);
  document.body.classList.add("workbench-resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", cancelPointer);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", key, true);
  handle.addEventListener("lostpointercapture", cancelPointer);
  return cleanup;
}

export function WorkbenchResizer(props: WorkbenchResizerProps) {
  const current = useRef(props);
  current.current = props;
  const cleanup = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => cleanup.current?.(), []);

  return (
    <div
      className={`workbench-resizer ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-label="调整右侧预览区宽度"
      aria-orientation="vertical"
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.width}
      aria-valuetext={`${props.width} 像素`}
      tabIndex={0}
      title="拖动或用左右方向键调整宽度；Shift 加速；双击或 Enter 恢复默认；Esc 取消拖动"
      onDoubleClick={props.onReset}
      onPointerDown={(event) => {
        if (event.button !== 0 || cleanup.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        setDragging(true);
        cleanup.current = captureDrag(event, current, () => {
          cleanup.current = null;
          setDragging(false);
        });
      }}
      onKeyDown={(event) => {
        if (dragging) return;
        const step = event.shiftKey ? 48 : 12;
        let width: number;
        if (event.key === "ArrowLeft") width = props.width + step;
        else if (event.key === "ArrowRight") width = props.width - step;
        else if (event.key === "Home") width = props.min;
        else if (event.key === "End") width = props.max;
        else if (event.key === "Enter") {
          event.preventDefault();
          props.onReset();
          return;
        } else return;
        event.preventDefault();
        props.onCommit(clampWorkbenchWidth(width, props.min, props.max));
      }}
    />
  );
}
