import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { App } from "@capacitor/app";
import { formatFileSize, isMobileUpdateSupported, isOfficialAndroidApk, type AndroidRelease } from "../mobileUpdate";
import { mobileUpdateScheduler } from "../mobileUpdateScheduler";
import { openMobileUpdateUrl } from "../mobileUpdateLinks";
import "./MobileUpdatePrompt.css";

export function MobileUpdatePrompt() {
  const showing = useRef(false);
  const [release, setRelease] = useState<AndroidRelease | null>(null);
  useEffect(() => {
    if (!isMobileUpdateSupported()) return;
    let disposed = false;
    let pending: AndroidRelease | null = null;
    let active = document.visibilityState !== "hidden";
    const show = () => {
      if (disposed || !active || showing.current || !pending || document.querySelector("dialog[open]")) return;
      if (!mobileUpdateScheduler.canPrompt(pending.version)) { pending = null; return; }
      showing.current = true;
      // Persist before showing: remounts and returning from the browser cannot repeat the prompt.
      mobileUpdateScheduler.defer(pending.version);
      setRelease(pending);
      pending = null;
    };
    const check = async () => {
      if (disposed || !active || showing.current) return;
      const result = await mobileUpdateScheduler.run();
      if (disposed) return;
      if (result.phase === "available") pending = result.release;
      show();
    };
    const timer = setTimeout(() => void check(), 2_000);
    const listener = App.addListener("appStateChange", (state) => {
      active = state.isActive;
      if (active) { show(); void check(); }
    });
    void listener.catch(() => undefined);
    const observer = new MutationObserver(show);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    const visibility = () => { active = document.visibilityState !== "hidden"; if (active) { show(); void check(); } };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, []);
  return release ? <MobileUpdateDialog release={release} onClose={() => { showing.current = false; setRelease(null); }} /> : null;
}

export function MobileUpdateDialog({ release, onClose }: { release: AndroidRelease; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const later = useRef<HTMLButtonElement>(null);
  const title = useId(), description = useId();
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    later.current?.focus();
    return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const close = () => { mobileUpdateScheduler.defer(release.version); onClose(); };
  const open = async () => {
    if (opening) return;
    setOpening(true); setError(false);
    try {
      if (!isOfficialAndroidApk(release.url)) throw new Error("Invalid APK");
      await openMobileUpdateUrl(release.url);
      close();
    } catch { setError(true); } finally { setOpening(false); }
  };
  const size = formatFileSize(release.fileSize);
  return createPortal(<dialog ref={dialog} className="mobile-update-dialog" aria-labelledby={title} aria-describedby={description}
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <h2 id={title}>发现新版本 {release.version}</h2>
    <p id={description}>miniQ Android 新版本已可下载{size ? `（${size}）` : ""}。将在系统浏览器中打开官方 APK，下载后按系统提示安装。</p>
    <h3>更新说明</h3>
    {release.releaseNotes?.length ? <ul>{release.releaseNotes.map((note, index) => <li key={index}>{note}</li>)}</ul> : <p>新版本已发布，欢迎更新体验。</p>}
    {release.installationNotes.length > 0 && <ul>{release.installationNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    {error && <p role="alert">无法打开下载链接，请稍后重试。</p>}
    <footer><button type="button" ref={later} onClick={close}>稍后提醒</button>
      <button type="button" className="primary" disabled={opening} onClick={() => void open()}>{opening ? "正在打开…" : "立即更新"}</button></footer>
  </dialog>, document.body);
}
