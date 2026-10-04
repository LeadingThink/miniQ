import { Download, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BACKGROUNDS, type BackgroundDefinition } from "../backgroundCatalog";
import { mobileBackgroundPolicy, type MobileMotion, type MobileNetwork, type VideoDownloadStatus } from "../mobileBackgroundPolicy";
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

export interface MobileAppearanceSheetProps {
  onClose?: () => void;
}

export function MobileAppearanceSheet({ onClose }: MobileAppearanceSheetProps) {
  const snapshot = useMobilePolicySnapshot();
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [clearing, setClearing] = useState(false);
  const [cacheError, setCacheError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const active = useMemo(() => BACKGROUNDS.find((item) => item.id === snapshot.preferences.background) ?? BACKGROUNDS[0], [snapshot.preferences.background]);
  const videoStatuses = useMemo(() => new Map(BACKGROUNDS.filter((item) => item.kind === "video" && item.video).map((item) => [item.id, mobileBackgroundPolicy.getVideoStatus(item.video!)])), [snapshot]);
  const cachedStatuses = [...videoStatuses.values()].filter((status) => status.status === "cached");
  const cacheBytes = cachedStatuses.reduce((sum, status) => sum + (status.bytes ?? 0), 0);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { previous?.focus(); };
  }, []);

  const download = async (item: BackgroundDefinition) => {
    if (!item.video) return;
    setDownloadErrors((errors) => { const next = { ...errors }; delete next[item.id]; return next; });
    try { await mobileBackgroundPolicy.retryVideo(item.video); }
    catch { setDownloadErrors((errors) => ({ ...errors, [item.id]: "下载失败，请检查网络后重试" })); }
  };
  const clear = async () => {
    setClearing(true); setCacheError("");
    try { await mobileBackgroundPolicy.clearVideoCache(); }
    catch { setCacheError("清理缓存失败，请重试"); }
    finally { setClearing(false); }
  };

  return (
    <div className="mobile-appearance-backdrop" role="presentation">
      <section ref={dialog} tabIndex={-1} className="mobile-appearance-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-appearance-title" onKeyDown={(event) => {
        if (event.key === "Escape" && onClose) { event.preventDefault(); onClose(); }
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'));
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <header className="mobile-appearance-header">
          <div><p className="mobile-appearance-eyebrow">移动设置</p><h2 id="mobile-appearance-title">外观</h2></div>
          {onClose && <button type="button" className="mobile-appearance-icon" aria-label="关闭外观设置" onClick={onClose}><X size={20} /></button>}
        </header>

        <div className="mobile-appearance-scroll">
          <MobileBackgroundLibrary />
          <section className="mobile-appearance-section" aria-labelledby="mobile-motion-title">
            <h3 id="mobile-motion-title">动态效果</h3>
            <div className="mobile-appearance-options" role="radiogroup" aria-label="动态效果">{([ ["standard", "标准"], ["low-power", "低功耗"], ["system", "跟随系统减少动态"] ] as const).map(([value, label]) => <MotionOption key={value} value={value} label={label} selected={snapshot.preferences.motion} onChange={(next) => mobileBackgroundPolicy.setPreferences({ motion: next as MobileMotion })} />)}</div>
          </section>

          <section className="mobile-appearance-section" aria-labelledby="mobile-network-title">
            <h3 id="mobile-network-title">视频壁纸</h3>
            <label className="mobile-appearance-switch"><input type="checkbox" checked={snapshot.preferences.chargingOnly} onChange={(event) => mobileBackgroundPolicy.setPreferences({ chargingOnly: event.target.checked })} /><span>仅充电时播放</span></label>
            <p>默认开启，未充电时显示静态预览。</p>
            <div className="mobile-appearance-options" role="radiogroup" aria-label="视频下载网络策略">{([ ["wifi-only", "仅 Wi-Fi"], ["cellular-opt-in", "Wi-Fi 与移动网络"] ] as const).map(([value, label]) => <MotionOption key={value} value={value} label={label} selected={snapshot.preferences.network} onChange={(next) => mobileBackgroundPolicy.setPreferences({ network: next as MobileNetwork })} />)}</div>
            <div className="mobile-appearance-cache"><span><strong>缓存</strong><small>{formatBytes(cacheBytes)}{cachedStatuses.length ? ` · ${cachedStatuses.length} 个视频` : ""}</small></span><button type="button" onClick={() => void clear()} disabled={clearing || cachedStatuses.length === 0}><Trash2 size={15} />{clearing ? "清理中…" : "清理缓存"}</button></div>
            {cacheError && <p role="alert">{cacheError}</p>}
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

function MotionOption<T extends string>({ value, label, selected, onChange }: { value: T; label: string; selected: string; onChange: (value: T) => void }) {
  return <label className="mobile-appearance-option"><input type="radio" name={value.startsWith("wifi") || value === "cellular-opt-in" ? "mobile-network" : "mobile-motion"} value={value} checked={selected === value} onChange={() => onChange(value)} /><span>{label}</span></label>;
}
