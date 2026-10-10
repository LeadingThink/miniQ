import { Volume2 } from "lucide-react";
import { useState } from "react";
import { playTaskSound, setTaskSoundSettings, useTaskSoundSettings } from "../taskNotifications";
import { Switch } from "./ui/Switch";

export function TaskSoundSettings() {
  const settings = useTaskSoundSettings();
  const [status, setStatus] = useState<string | null>(null);

  const update = (change: Parameters<typeof setTaskSoundSettings>[0]) => {
    try {
      setTaskSoundSettings(change);
      setStatus(null);
    } catch {
      setStatus("无法保存音效设置，请检查本机存储是否可用。");
    }
  };

  const preview = async () => {
    const played = await playTaskSound("completed", { userInitiated: true, ignoreSettings: true });
    setStatus(played ? "试听音效已播放。" : settings.volume === 0 ? "音量为 0，请提高音量后试听。" : "音效暂不可用，请再次点击试听或检查设备声音设置。");
  };

  return (
    <div className="task-sound-settings" aria-label="任务音效">
      <div className="settings-section-title"><Volume2 size={15} /><span>本地音效</span></div>
      <p className="settings-section-description">音效由这台设备播放，无需系统通知权限。试听使用当前音量，任务音效遵守下方的免打扰时段。</p>
      <div className="settings-toggle-row">
        <span>开启本地音效</span>
        <Switch checked={settings.enabled} onChange={(enabled) => update({ enabled })} label="开启本地音效" />
      </div>
      <div className="settings-toggle-row">
        <span>任务完成音效</span>
        <Switch checked={settings.completed} onChange={(completed) => update({ completed })} label="任务完成音效" />
      </div>
      <div className="settings-toggle-row">
        <span>任务失败音效</span>
        <Switch checked={settings.failed} onChange={(failed) => update({ failed })} label="任务失败音效" />
      </div>
      <div className="settings-toggle-row">
        <span>需要操作音效</span>
        <Switch checked={settings.attention} onChange={(attention) => update({ attention })} label="需要操作音效" />
      </div>
      <div className="settings-toggle-row">
        <span>仅后台播放</span>
        <Switch checked={settings.backgroundOnly} onChange={(backgroundOnly) => update({ backgroundOnly })} label="仅后台播放" />
      </div>
      <label className="settings-toggle-row" htmlFor="task-sound-volume">
        <span>音量 <small>{Math.round(settings.volume * 100)}%</small></span>
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
      </label>
      <div className="settings-actions">
        <button type="button" className="secondary" onClick={() => void preview()}>
          <Volume2 size={14} />
          试听音效
        </button>
      </div>
      {status && <p role="status">{status}</p>}
    </div>
  );
}
