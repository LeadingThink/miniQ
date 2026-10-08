import { ChevronDown, ChevronUp, LoaderCircle, LocateFixed } from "lucide-react";

export function SessionSearchNavigator(props: {
  count: number;
  position: number;
  /** More matching records exist in older history pages. */
  more: boolean;
  loading: boolean;
  onStep: (direction: -1 | 1) => void;
  onLocate?: () => void;
}) {
  const empty = props.count === 0;
  return (
    <div className="session-search-nav" role="group" aria-label="搜索结果导航">
      <span className="session-search-count" role="status" aria-live="polite">
        {props.loading && empty ? "正在搜索" : empty ? "无匹配" : `${props.position} / ${props.count}${props.more ? "+" : ""}`}
      </span>
      <button
        type="button"
        className="icon-button"
        title="上一个结果（更早，Enter）"
        aria-label="上一个结果"
        disabled={empty}
        onClick={() => props.onStep(-1)}
      >
        {props.loading && !empty ? <LoaderCircle size={16} className="activity-spinner" /> : <ChevronUp size={16} />}
      </button>
      <button
        type="button"
        className="icon-button"
        title="下一个结果（更新，Shift+Enter）"
        aria-label="下一个结果"
        disabled={empty}
        onClick={() => props.onStep(1)}
      >
        <ChevronDown size={16} />
      </button>
      {props.onLocate && (
        <button
          type="button"
          className="ghost session-search-locate"
          title="退出搜索，在完整会话中查看这条记录"
          disabled={empty}
          onClick={props.onLocate}
        >
          <LocateFixed size={14} />
          查看上下文
        </button>
      )}
    </div>
  );
}
