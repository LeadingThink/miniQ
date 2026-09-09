import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minus,
  Plus,
  Scan,
} from "lucide-react";
import type { ReactNode } from "react";
import { clampDocumentZoom, clampPage } from "../documentPreviewModel";

export function DocumentControls(props: {
  label: string;
  page: number;
  count: number;
  onPage: (page: number) => void;
  scale: number;
  fit: boolean;
  onScale: (scale: number) => void;
  onFit: () => void;
  children?: ReactNode;
}) {
  const { label, page, count, onPage, scale, fit, onScale, onFit } = props;
  return (
    <div className="pdf-toolbar" aria-label={`${label} 控制栏`}>
      <button
        type="button"
        className="icon-button"
        aria-label="上一页"
        title="上一页"
        disabled={page <= 1 || !count}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft size={16} />
      </button>
      <label className="pdf-page-input">
        <input
          aria-label={`${label} 页码`}
          type="number"
          min={1}
          max={Math.max(count, 1)}
          value={page}
          disabled={!count}
          onChange={(event) => {
            if (Number.isFinite(event.target.valueAsNumber))
              onPage(clampPage(event.target.valueAsNumber, count));
          }}
        />{" "}
        / {count}
      </label>
      <button
        type="button"
        className="icon-button"
        aria-label="下一页"
        title="下一页"
        disabled={page >= count}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight size={16} />
      </button>
      <span className="pdf-toolbar-separator" />
      <button
        type="button"
        className="icon-button"
        aria-label={`缩小 ${label}`}
        title="缩小"
        disabled={!count || scale <= 0.1}
        onClick={() => onScale(clampDocumentZoom(scale - 0.1))}
      >
        <Minus size={15} />
      </button>
      <output className="document-scale">{Math.round(scale * 100)}%</output>
      <button
        type="button"
        className="icon-button"
        aria-label={`放大 ${label}`}
        title="放大"
        disabled={!count || scale >= 4}
        onClick={() => onScale(clampDocumentZoom(scale + 0.1))}
      >
        <Plus size={15} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`重置 ${label} 缩放`}
        title="原始尺寸"
        disabled={!count || (scale === 1 && !fit)}
        onClick={() => onScale(1)}
      >
        <Scan size={16} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`适配 ${label} 宽度`}
        title="适配宽度"
        aria-pressed={fit}
        disabled={!count}
        onClick={onFit}
      >
        <Maximize size={16} />
      </button>
      {props.children}
    </div>
  );
}
