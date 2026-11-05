import { LoaderCircle, Paperclip, RotateCcw, X } from "lucide-react";
import type { ComposerUploadItem } from "../composerUploads";
import "./ComposerUploadList.css";

export function ComposerUploadList(props: {
  items: ComposerUploadItem[];
  onRetry: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  if (!props.items.length) return null;
  return <ul className="composer-uploads" aria-label="待上传附件">
    {props.items.map(item => <li key={item.id} data-state={item.state}>
      {item.state === "failed" ? <Paperclip size={14} /> : <LoaderCircle size={14} className="activity-spinner" />}
      <span className="composer-upload-name" title={item.name}>{item.name}</span>
      <span className="composer-upload-status">{item.state === "preparing" ? "准备中" : item.state === "failed" ? "上传失败" : item.progress === 100 ? "等待收件" : `上传中 ${item.progress}%`}</span>
      {item.state === "failed" && <button type="button" aria-label={`重试上传 ${item.name}`} onClick={() => props.onRetry(item.id)}><RotateCcw size={14} /></button>}
      <button type="button" aria-label={`移除待上传附件 ${item.name}`} onClick={() => props.onRemove(item.id)}><X size={14} /></button>
      {item.state === "uploading" && <progress aria-label={`${item.name} 上传进度`} max={100} value={item.progress} />}
      {item.error && <span className="composer-upload-error" role="alert">{item.error}</span>}
    </li>)}
  </ul>;
}
