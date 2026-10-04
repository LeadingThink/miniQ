import { getAppearance, storeTheme, subscribeAppearance } from "../theme";
import { ThemePicker } from "./ThemePicker";
import type { AppPlugin } from "@capacitor/app";
import { Download, Trash2, X } from "lucide-react";
import { useId, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isNativeMobileApp } from "../mobileRuntime";
import { BACKGROUNDS, type BackgroundDefinition } from "../backgroundCatalog";
import { mobileBackgroundPolicy, type VideoDownloadStatus } from "../mobileBackgroundPolicy";
import { MobileBackgroundLibrary } from "./MobileBackgroundLibrary";
import "./MobileAppearanceSheet.css";

function formatBytes(bytes: number) {
  if (!bytes) return "暂无缓存";
  return `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function useMobilePolicySnapshot() {
  return useSyncExternalStore(
    (listener) => mobileBackgroundPolicy.subscribe(listener),
    () => mobileBackgroundPolicy.getSnapshot(),
    () => mobileBackgroundPolicy.getSnapshot(),
  );
}

let appModule: Promise<typeof import("@capacitor/app")> | undefined;

// Both the entry screen and the connected workspace use the sheet's back handling.
export function useMobileBackButton(onBack: (app: AppPlugin) => void, enabled = true) {
  const callback = useRef(onBack);
  useLayoutEffect(() => { callback.current = onBack; }, [onBack]);

  useEffect(() => {
    if (!enabled || !isNativeMobileApp()) return;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;
    const remove = (handle: { remove: () => Promise<void> }) => {
      void handle.remove().catch(() => {});
    };
    void (appModule ??= import("@capacitor/app")).then(async ({ App }) => {
      if (disposed) return;
      const handle = await App.addListener("backButton", () => {
        // Native removal can finish later; retired callbacks must already be inert.
        if (!disposed) callback.current(App);
      });
      if (disposed) remove(handle);
      else listener = handle;
    }).catch(() => {});
    return () => {
      disposed = true;
      if (listener) remove(listener);
    };
  }, [enabled]);
}

export interface MobileAppearanceSheetProps {
  onClose?: () => void;
  embedded?: boolean;
}

export function MobileAppearanceSheet({ onClose, embedded = false }: MobileAppearanceSheetProps) {
  useMobileBackButton(() => onClose?.(), !embedded && Boolean(onClose));
  const snapshot = useMobilePolicySnapshot();
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [clearing, setClearing] = useState(false);
  const [cacheError, setCacheError] = useState("");
  const titleId = useId();
  const cacheTitleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const active = useMemo(() => BACKGROUNDS.find((item) => item.id === snapshot.preferences.background) ?? BACKGROUNDS[0], [snapshot.preferences.background]);
  const videoStatuses = useMemo(() => new Map(BACKGROUNDS.filter((item) => item.kind === "video" && item.video).map((item) => [item.id, mobileBackgroundPolicy.getVideoStatus(item.video!)])), [snapshot]);
  const cachedStatuses = [...videoStatuses.values()].filter((status) => status.status === "cached");
  const cacheBytes = cachedStatuses.reduce((sum, status) => sum + (status.bytes ?? 0), 0);

  useEffect(() => {
    if (embedded) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { previous?.focus(); };
  }, [embedded]);

  const download = async (item: BackgroundDefinition) => {
    if (!item.video) return;
    setDownloadErrors((errors) => { const next = { ...errors }; delete next[item.id]; return next; });
    try { await mobileBackgroundPolicy.retryVideo(item.video); }
    catch {
      setDownloadErrors((errors) => ({ ...errors, [item.id]: "下载失败，请重试" }));
    }
  };
  const clear = async () => {
    setClearing(true); setCacheError("");
    try { await mobileBackgroundPolicy.clearVideoCache(); }
    catch { setCacheError("清理缓存失败，请重试"); }
    finally { setClearing(false); }
  };

  return (
    <div className={embedded ? "mobile-appearance-embedded" : "mobile-appearance-backdrop"} role="presentation">
      <section ref={dialog} tabIndex={-1} className="mobile-appearance-sheet" role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby={titleId} onKeyDown={(event) => {
        if (embedded) return;
        if (event.key === "Escape" && onClose) { event.preventDefault(); onClose(); }
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'));
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <header className="mobile-appearance-header">
          <div><p className="mobile-appearance-eyebrow">移动设置</p><h2 id={titleId}>外观</h2></div>
          {onClose && <button type="button" className="mobile-appearance-icon" aria-label="关闭外观设置" onClick={onClose}><X size={20} /></button>}
        </header>

        <div className="mobile-appearance-scroll">
          <p>应用于手机和远程控制界面；仅在当前设备生效。</p>
          <ThemePicker theme={appearance.theme} onThemeChange={storeTheme} showBackground={false} />
          <MobileBackgroundLibrary />
          <section className="mobile-appearance-section" aria-labelledby={cacheTitleId}>
            <h3 id={cacheTitleId}>视频壁纸</h3>
            <div className="mobile-appearance-cache"><span><strong>缓存</strong><small>{formatBytes(cacheBytes)}{cachedStatuses.length ? ` · ${cachedStatuses.length} 个视频` : ""}</small></span><button type="button" onClick={() => void clear()} disabled={clearing || cachedStatuses.length === 0}><Trash2 size={15} />{clearing ? "清理中…" : "清理缓存"}</button></div>
            {cacheError && <p className="mobile-appearance-error" role="alert">{cacheError}</p>}
            {Object.entries(downloadErrors).map(([id, error]) => <p className="mobile-appearance-error" role="alert" key={id}><Download size={15} />{error}</p>)}
            {[active].filter((item) => item.kind === "video").map((item) => {
              const status: VideoDownloadStatus = item.video ? mobileBackgroundPolicy.getVideoStatus(item.video).status : "idle";
              return <button className="mobile-appearance-download" type="button" key={item.id} disabled={!item.video || status === "downloading"} onClick={() => void download(item)}><Download size={15} />{status === "downloading" ? "下载中…" : status === "cached" ? `重试播放「${item.name}」` : status === "error" ? "重试下载" : `下载「${item.name}」`}</button>;
            })}
          </section>
        </div>
      </section>
    </div>
  );
}
