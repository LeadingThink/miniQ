import { Play, Volume2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { playTaskSound, setTaskSoundSettings, useTaskSoundSettings } from "../taskNotifications";
import type { TaskNotificationKind } from "../taskBanner";
import { Button } from "./ui/Button";
import { Switch } from "./ui/Switch";
import "./NotificationSettings.css";

const KINDS: { kind: TaskNotificationKind; label: string }[] = [
  { kind: "completed", label: "完成" },
  { kind: "failed", label: "失败" },
  { kind: "attention", label: "需要处理" },
];

/** Desktop-only 提醒音效 section. `quietHours` is rendered inside because on desktop it only mutes sounds. */
export function TaskSoundSettings({ quietHours }: { quietHours?: (onStatus: (text: string | null) => void) => ReactNode }) {
  const settings = useTaskSoundSettings();
  const [error, setError] = useState<string | null>(null);

  const update = (change: Parameters<typeof setTaskSoundSettings>[0]) => {
    try {
      setTaskSoundSettings(change);
      setError(null);
    } catch {
      setError("无法保存音效设置，请检查本机存储是否可用。");
    }
  };

  const preview = async (kind: TaskNotificationKind) => {
    const played = await playTaskSound(kind, { userInitiated: true, ignoreSettings: true });
    setError(played ? null : settings.volume === 0 ? "音量为 0，请提高音量后试听。" : "音效暂不可用，请再试一次或检查设备声音设置。");
  };

  const percent = Math.round(settings.volume * 100);

  return (
    <section className="settings-section" aria-label="提醒音效">
      <div>
        <div className="settings-section-title"><Volume2 size={15} /><span>提醒音效</span></div>
        <p className="settings-section-description">由这台设备本地播放，无需系统通知权限。</p>
      </div>
      <div className="remote-access-toggle">
        <span>
          <strong>提醒音效</strong>
          <small>任务完成、失败或需要你处理时播放提示音</small>
        </span>
        <Switch checked={settings.enabled} onChange={(enabled) => update({ enabled })} label="提醒音效" />
      </div>
      {settings.enabled && <>
        <div className="settings-card" role="group" aria-label="播放提示音的情况">
          {KINDS.map(({ kind, label }) => (
            <div className="settings-toggle-row" key={kind}>
              <span className="settings-row-label">{label}</span>
              <span className="settings-row-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`试听${label}提示音`}
                  title={`试听${label}提示音`}
                  icon={<Play size={13} />}
                  onClick={() => void preview(kind)}
                />
                <Switch checked={settings[kind]} onChange={(value) => update({ [kind]: value })} label={`${label}提示音`} />
              </span>
            </div>
          ))}
        </div>
        <div className="settings-card">
          <div className="settings-toggle-row">
            <span className="settings-row-label">仅在 miniQ 不在前台时播放</span>
            <Switch checked={settings.backgroundOnly} onChange={(backgroundOnly) => update({ backgroundOnly })} label="仅在 miniQ 不在前台时播放" />
          </div>
          <div className="settings-toggle-row task-sound-volume">
            <label className="settings-row-label" htmlFor="task-sound-volume">音量</label>
            <input
              id="task-sound-volume"
              aria-label="音量"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={settings.volume}
              onChange={(event) => update({ volume: Number(event.target.value) })}
            />
            <output htmlFor="task-sound-volume" aria-live="off">{percent}%</output>
          </div>
        </div>
        {quietHours?.(setError)}
      </>}
      {error && <p className="settings-error" role="alert">{error}</p>}
    </section>
  );
}
