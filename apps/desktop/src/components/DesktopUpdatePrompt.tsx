import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AppUpdaterState } from "../hooks/useAppUpdater";
import { desktopInstalledReleaseNotices, type InstalledReleaseNotice } from "../installedReleaseNotice";
import { UPDATE_REMINDER_COOLDOWN_MS, UpdateStamps } from "../updatePolicy";
import { InstalledReleaseDialog } from "./InstalledReleaseDialog";
// The dialog chrome is shared with the mobile update prompt.
import "./MobileUpdatePrompt.css";

export const desktopUpdateStamps = new UpdateStamps("miniq:desktop-update:");

export interface DesktopUpdater {
  supported: boolean;
  state: AppUpdaterState;
  checkNow: () => Promise<void>;
  install: () => Promise<void>;
}

/** True while no other modal is open, so update prompts never stack on a task dialog. */
function useNoOtherDialog(): boolean {
  const read = () => !document.querySelector("dialog[open]") && document.visibilityState === "visible";
  const [idle, setIdle] = useState(read);
  useEffect(() => {
    const update = () => setIdle(read());
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return idle;
}

function progressLabel(state: AppUpdaterState): string {
  if (state.phase === "installing") return "正在安装更新，完成后将自动重启";
  if (!state.totalBytes) return "正在下载更新…";
  return `正在下载 ${Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))}%`;
}

/** Announces a new desktop version and, once, what changed after an upgrade. */
export function DesktopUpdatePrompt({ updater }: { updater: DesktopUpdater }) {
  const { state, supported } = updater;
  const idle = useNoOtherDialog();
  const [installed, setInstalled] = useState<InstalledReleaseNotice | null>(null);
  const [view, setView] = useState<"installed" | "available" | null>(null);
  const announced = useRef(new Set<string>());

  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    void import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then((version) => {
      // First launch records the baseline; only a later upgrade is announced.
      if (!disposed) setInstalled(desktopInstalledReleaseNotices.pending(version));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [supported]);

  useEffect(() => {
    if (state.phase === "available" && state.version) {
      desktopInstalledReleaseNotices.cache({ platform: "desktop", version: state.version, releaseNotes: state.releaseNotes });
    }
  }, [state.phase, state.version, state.releaseNotes]);

  useEffect(() => {
    if (!supported || view || !idle) return;
    if (installed) { setView("installed"); return; }
    const version = state.phase === "available" ? state.version : null;
    if (!version || announced.current.has(version)) return;
    announced.current.add(version);
    if (desktopUpdateStamps.recent(`reminder:${version}`, UPDATE_REMINDER_COOLDOWN_MS)) return;
    // Persist before showing so a relaunch cannot repeat the same prompt.
    desktopUpdateStamps.stamp(`reminder:${version}`);
    setView("available");
  }, [supported, view, idle, installed, state.phase, state.version]);

  if (view === "installed" && installed) {
    return <InstalledReleaseDialog notice={installed} notices={desktopInstalledReleaseNotices}
      onClose={() => { setInstalled(null); setView(null); }} />;
  }
  if (view === "available") return <AvailableDialog updater={updater} onClose={() => setView(null)} />;
  return null;
}

function AvailableDialog({ updater, onClose }: { updater: DesktopUpdater; onClose: () => void }) {
  const { state } = updater;
  const dialog = useRef<HTMLDialogElement>(null);
  const later = useRef<HTMLButtonElement>(null);
  const title = useId(), description = useId();
  const busy = state.phase === "downloading" || state.phase === "installing";
  const failed = state.phase === "error";
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    later.current?.focus();
    return () => element.close();
  }, []);
  return createPortal(<dialog ref={dialog} className="mobile-update-dialog" aria-labelledby={title} aria-describedby={description}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id={title}>发现新版本 {state.version ? `v${state.version}` : ""}</h2>
    <p id={description}>miniQ 新版本已发布。更新会下载安装包并自动重启；任务执行中无法安装，请等待任务完成。</p>
    <h3>更新说明</h3>
    {state.releaseNotes.length
      ? <ul>{state.releaseNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>
      : <p>新版本已发布，欢迎更新体验。</p>}
    {busy && <div role="status"><p>{progressLabel(state)}</p>
      {state.totalBytes ? <progress max={state.totalBytes} value={state.downloadedBytes} aria-label="更新下载进度" /> : null}</div>}
    {failed && <p role="alert">{state.error || "更新失败，请稍后重试。"}</p>}
    <footer>
      <button type="button" ref={later} disabled={busy} onClick={onClose}>{failed ? "关闭" : "稍后提醒"}</button>
      {failed
        ? <button type="button" className="primary" onClick={() => void updater.checkNow()}>重新检查</button>
        : <button type="button" className="primary" disabled={busy || state.phase !== "available"} onClick={() => void updater.install()}>
          {busy ? "更新中…" : "立即更新"}</button>}
    </footer>
  </dialog>, document.body);
}
