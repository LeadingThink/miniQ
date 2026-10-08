import { Activity, Check, LayoutList, MessageSquare, TriangleAlert, X } from "lucide-react";
import type { TimelineFilter } from "../timelineModel";
import { Dialog } from "./ui/Dialog";

const options = [
  { value: "all", label: "全部记录", description: "查看完整会话记录", Icon: LayoutList },
  { value: "answers", label: "回答记录", description: "查看对话消息和生成文件", Icon: MessageSquare },
  { value: "activity", label: "执行记录", description: "查看工具调用和执行过程", Icon: Activity },
  { value: "errors", label: "异常记录", description: "查看失败、拒绝和取消的执行", Icon: TriangleAlert },
] as const;

export function TimelineFilterSheet(props: {
  open: boolean;
  filter: TimelineFilter;
  counts?: Record<TimelineFilter, number>;
  onFilter: (filter: TimelineFilter) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={props.open} title="筛选记录" className="timeline-filter-sheet" onClose={props.onClose}>
      <button type="button" className="timeline-filter-close" aria-label="关闭记录筛选" onClick={props.onClose}><X size={20} aria-hidden="true" /></button>
      <p className="timeline-filter-hint">{props.counts ? "记录类型 · 数量为当前已加载记录" : "记录类型"}</p>
      <div className="timeline-filter-options" role="group" aria-label="选择记录类型">
        {options.map(({ value, label, description, Icon }) => (
          <button type="button" key={value} className={`timeline-filter-option timeline-filter-option-${value}`} aria-pressed={props.filter === value} data-autofocus={props.filter === value ? "true" : undefined} onClick={() => { props.onFilter(value); props.onClose(); }}>
            <span className="timeline-filter-icon"><Icon size={19} aria-hidden="true" /></span>
            <span className="timeline-filter-copy"><strong>{label}</strong><small>{description}</small></span>
            {props.counts && <span className="timeline-filter-count">{props.counts[value]}</span>}
            <span className="timeline-filter-check" aria-hidden="true">{props.filter === value && <Check size={14} strokeWidth={3} />}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
