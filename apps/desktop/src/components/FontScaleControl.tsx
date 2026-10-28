import { useId, useSyncExternalStore } from "react";
import { FONT_SIZE_LIMITS, getFontSize, storeFontSize, subscribeFontScale } from "../fontScale";

export function FontScaleControl() {
  const controlId = useId();
  const size = useSyncExternalStore(subscribeFontScale, getFontSize, getFontSize);
  return (
    <section className="font-scale-control" aria-label="字体">
      <label className="font-size-row" htmlFor={`${controlId}-interface`}>
        <span className="font-size-copy">
          <strong>界面字号</strong>
          <small>调整聊天和设置界面的基础字号</small>
        </span>
        <span className="font-size-input">
          <input
            id={`${controlId}-interface`}
            type="number"
            min={FONT_SIZE_LIMITS.min}
            max={FONT_SIZE_LIMITS.max}
            step={1}
            value={size}
            aria-label="界面字号"
            onChange={(event) => storeFontSize(Number(event.target.value))}
          />
          <small>px</small>
        </span>
      </label>
    </section>
  );
}
