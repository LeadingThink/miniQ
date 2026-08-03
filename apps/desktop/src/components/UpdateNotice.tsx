import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import type { AppUpdaterState } from "../hooks/useAppUpdater";

interface UpdateNoticeProps {
  supported: boolean;
  state: AppUpdaterState;
  onCheck: () => void;
  onInstall: () => void;
}

function progressLabel(state: AppUpdaterState): string {
  if (!state.totalBytes) return "正在下载更新";
  const percent = Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100));
  return `正在下载 ${percent}%`;
}

export function UpdateNotice({ supported, state, onCheck, onInstall }: UpdateNoticeProps) {
  if (!supported) return null;

  if (state.phase === "idle") {
    return (
      <button type="button" className="nav-item sidebar-nav-button" onClick={onCheck}>
        <RefreshCw className="nav-icon" size={16} />
        <span>检查更新</span>
      </button>
    );
  }

  if (state.phase === "available") {
    return (
      <button type="button" className="nav-item sidebar-nav-button update-notice" onClick={onInstall}>
        <Download className="nav-icon" size={16} />
        <span>更新至 v{state.version}</span>
      </button>
    );
  }

  if (state.phase === "error") {
    return (
      <button
        type="button"
        className="nav-item sidebar-nav-button update-notice update-error"
        title={state.error ?? "更新失败"}
        onClick={onCheck}
      >
        <RefreshCw className="nav-icon" size={16} />
        <span>更新失败，重试</span>
      </button>
    );
  }

  const label =
    state.phase === "checking"
      ? "正在检查更新"
      : state.phase === "installing"
        ? "正在安装更新"
        : progressLabel(state);
  return (
    <div className="nav-item update-notice update-busy" aria-live="polite">
      <LoaderCircle className="nav-icon update-spinner" size={16} />
      <span>{label}</span>
    </div>
  );
}
