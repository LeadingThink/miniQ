import { Capacitor } from "@capacitor/core";
import { iosInstalledReleaseNotices, type InstalledReleaseNotice } from "../iosInstalledReleaseNotice";
import { IosInstalledReleaseDialog } from "./IosInstalledReleaseDialog";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { App } from "@capacitor/app";
import { formatFileSize, readInstalledVersion, isOfficialIosAppStoreUrl, isMobileUpdateSupported, isOfficialAndroidApk, type AndroidRelease } from "../mobileUpdate";
import { mobileUpdateScheduler } from "../mobileUpdateScheduler";
import { openMobileUpdateUrl } from "../mobileUpdateLinks";
import "./MobileUpdatePrompt.css";

let promptOwner: symbol | null = null;
const PROMPT_RELEASED = "miniq:mobile-update-prompt-released";

export function MobileUpdatePrompt() {
  const showing = useRef(false);
  const showingInstalled = useRef(false);
  const owner = useRef(Symbol());
  const wake = useRef(() => {});
  const [notice, setNotice] = useState<InstalledReleaseNotice | null>(null);
  const [release, setRelease] = useState<AndroidRelease | null>(null);
  useEffect(() => {
    if (!isMobileUpdateSupported()) return;
    let disposed = false;
    let pending: AndroidRelease | null = null;
    let installed: string | null = null;
    const ios = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
    let ready = !ios;
    let active = document.visibilityState !== "hidden";
    const show = () => {
      if (disposed || !ready || !active || showing.current || promptOwner || document.querySelector("dialog[open]")) return;
      const installedNotice = installed ? iosInstalledReleaseNotices.pending(installed) : null;
      if (installedNotice) {
        promptOwner = owner.current;
        showing.current = true;
        showingInstalled.current = true;
        setNotice(installedNotice);
        return;
      }
      if (!pending) return;
      if (!mobileUpdateScheduler.canPrompt(pending.version)) { pending = null; return; }
      showing.current = true;
      promptOwner = owner.current;
      // Persist before showing: remounts and returning from the browser cannot repeat the prompt.
      mobileUpdateScheduler.defer(pending.version);
      setRelease(pending);
      pending = null;
    };
    const check = async () => {
      if (disposed || !active || (showing.current && !showingInstalled.current)) return;
      const result = await mobileUpdateScheduler.run().catch(() => ({ phase: "idle" as const }));
      if (disposed) return;
      if (result.phase === "available") {
        iosInstalledReleaseNotices.cache(result.release);
        pending = result.release;
      }
      show();
    };
    wake.current = show;
    document.addEventListener(PROMPT_RELEASED, show);
    if (ios) void readInstalledVersion().then((version) => {
      if (disposed) return;
      installed = version;
      if (version) iosInstalledReleaseNotices.pending(version);
      ready = true;
      show();
    });
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
      document.removeEventListener(PROMPT_RELEASED, show);
      wake.current = () => {};
      showing.current = false;
      if (promptOwner === owner.current) {
        promptOwner = null;
        queueMicrotask(() => document.dispatchEvent(new Event(PROMPT_RELEASED)));
      }
      document.removeEventListener("visibilitychange", visibility);
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, []);
  const close = () => {
    setNotice(null); setRelease(null);
    showingInstalled.current = false;
    showing.current = false;
    if (promptOwner === owner.current) promptOwner = null;
    // The closing dialog leaves the DOM before queued prompts are considered.
    queueMicrotask(() => { wake.current(); document.dispatchEvent(new Event(PROMPT_RELEASED)); });
  };
  if (notice) return <IosInstalledReleaseDialog notice={notice} onClose={close} />;
  return release ? <MobileUpdateDialog release={release} onClose={close} /> : null;
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
      if (release.platform === "ios" ? !isOfficialIosAppStoreUrl(release.url) : !isOfficialAndroidApk(release.url)) throw new Error("Invalid update URL");
      await openMobileUpdateUrl(release.url);
      close();
    } catch { setError(true); } finally { setOpening(false); }
  };
  const ios = release.platform === "ios";
  const size = formatFileSize(release.fileSize);
  return createPortal(<dialog ref={dialog} className="mobile-update-dialog" aria-labelledby={title} aria-describedby={description}
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <h2 id={title}>发现新版本 {release.version}</h2>
    <p id={description}>{ios ? "miniQ iOS 新版本已在 App Store 发布。前往 App Store 查看并更新。" : `miniQ Android 新版本已可下载${size ? `（${size}）` : ""}。将在系统浏览器中打开官方 APK，下载后按系统提示安装。`}</p>
    <h3>更新说明</h3>
    {release.releaseNotes?.length ? <ul>{release.releaseNotes.map((note, index) => <li key={index}>{note}</li>)}</ul> : <p>新版本已发布，欢迎更新体验。</p>}
    {release.installationNotes.length > 0 && <ul>{release.installationNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
    {error && <p role="alert">{ios ? "无法打开 App Store，请稍后重试。" : "无法打开下载链接，请稍后重试。"}</p>}
    <footer><button type="button" ref={later} onClick={close}>稍后提醒</button>
      <button type="button" className="primary" disabled={opening} onClick={() => void open()}>{opening ? "正在打开…" : ios ? "前往 App Store" : "立即更新"}</button></footer>
  </dialog>, document.body);
}
