import { BellRing, CheckCircle2, CircleAlert, X } from "lucide-react";
import { dismissTaskBanner, useTaskBanner, type TaskNotificationTarget } from "../taskBanner";
import "./TaskBanner.css";

/** In-app banner for task updates while the phone app is in the foreground. */
export function TaskBannerView({ onOpen }: { onOpen: (target: TaskNotificationTarget) => void }) {
  const banner = useTaskBanner();
  if (!banner) return null;
  const Icon = banner.kind === "attention" ? BellRing : banner.kind === "failed" ? CircleAlert : CheckCircle2;
  return (
    <div className={`task-banner task-banner-${banner.kind}`} role={banner.kind === "attention" ? "alert" : "status"}>
      <button
        type="button"
        className="task-banner-main"
        onClick={() => { dismissTaskBanner(); onOpen(banner.target); }}
      >
        <Icon size={18} aria-hidden="true" />
        <span className="task-banner-text">
          <strong>{banner.title}</strong>
          <span>{banner.body}</span>
        </span>
      </button>
      <button type="button" className="task-banner-close" aria-label="关闭提醒" onClick={dismissTaskBanner}>
        <X size={16} />
      </button>
    </div>
  );
}
