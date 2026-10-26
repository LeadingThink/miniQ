import { Check, RefreshCw } from "lucide-react";
import { desktopsWithSelection, type RemoteDesktop } from "../remoteDevices";
import { Button } from "./ui/Button";
import "./RemoteDevicePicker.css";

interface Props {
  devices: RemoteDesktop[];
  selected: RemoteDesktop | null;
  loading: boolean;
  error?: string | null;
  onSelect: (device: RemoteDesktop) => void;
  onRefresh: () => void;
}

/** A selection is always explicit; presence changes never choose a replacement. */
export function RemoteDevicePicker({
  devices, selected, loading, error, onSelect, onRefresh,
}: Props) {
  const entries = desktopsWithSelection(devices, selected);
  return (
    <section className="remote-device-picker" aria-label="选择连接的电脑" aria-busy={loading}>
      <header>
        <h2>切换电脑</h2>
        <Button variant="ghost" iconOnly aria-label="刷新电脑列表"
          disabled={loading} onClick={onRefresh} icon={<RefreshCw size={16} />} />
      </header>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在获取电脑列表…</p>}
      {!loading && entries.length === 0 && (
        <p role="status">尚未发现电脑。请在电脑上打开 miniQ，并使用同一个 Key 开启远程连接。</p>
      )}
      <div className="remote-device-options">
        {entries.map((device) => {
          const state = loading || error ? "unknown" : device.online ? "online" : "offline";
          return (
            <button type="button" key={device.id} aria-pressed={selected?.id === device.id}
              onClick={() => onSelect(device)}>
              <span className="remote-device-info">
                <strong>{device.name || "未命名电脑"}</strong>
                <small className={`remote-device-state ${state}`}>
                  <i aria-hidden="true" />
                  {state === "unknown" ? "状态待确认" : state === "online" ? "在线" : "离线"}
                </small>
              </span>
              {selected?.id === device.id && <Check size={18} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
