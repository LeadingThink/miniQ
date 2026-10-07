import { Laptop, RefreshCw } from "lucide-react";
import { desktopsWithSelection, type RemoteDesktop } from "../remoteDevices";
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
export function RemoteDevicePicker({ devices, selected, loading, error, onSelect, onRefresh }: Props) {
  const entries = desktopsWithSelection(devices, selected);
  return <section className="remote-device-picker" aria-label="选择连接的电脑" aria-busy={loading}>
    <header><h2>选择连接的电脑</h2><button type="button" className="secondary" disabled={loading} onClick={onRefresh} aria-label="刷新电脑列表"><RefreshCw size={16} />刷新</button></header>
    <p>选择使用这个 Key 的电脑。电脑离线时会等待它恢复，不会自动切换到其他电脑。</p>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">正在获取电脑列表…</p>}
    {!loading && entries.length === 0 && <p role="status">尚未发现电脑。请在电脑上打开 miniQ，并使用同一个 Key 开启远程连接。</p>}
    <div className="remote-device-options">
      {entries.map((device) => <button type="button" key={device.id} aria-pressed={selected?.id === device.id} onClick={() => onSelect(device)}>
        <Laptop size={20} /><span><strong>{device.name || "未命名电脑"}</strong><small>{device.id}</small></span>
        <span className="remote-device-state">{selected?.id === device.id && <small>当前选择</small>}<small>{loading || error ? "状态待确认" : device.online ? "在线" : "离线"}</small></span>
      </button>)}
    </div>
  </section>;
}
