import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";

interface DataDirectoryInfo {
  path: string;
  managedByEnvironment: boolean;
}

export function DataDirectorySettings() {
  const [info, setInfo] = useState<DataDirectoryInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void invoke<DataDirectoryInfo>("current_data_directory")
      .then(setInfo)
      .catch((error) => setStatus(`读取数据目录失败：${errorMessage(error)}`));
  }, []);

  const changeDirectory = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const path = await invoke<string>("choose_data_directory");
      setInfo({ path, managedByEnvironment: false });
      setStatus("数据已迁移，后台服务正在从新目录重新连接");
    } catch (error) {
      if (errorMessage(error) !== "用户取消了目录选择") setStatus(`迁移数据失败：${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return <section className="settings-section">
    <div className="settings-section-title"><span>数据目录</span></div>
    <p className="settings-section-description">会话、记忆、设置和本地缓存都保存在这里。更换目录会先停止后台服务并迁移完整数据。</p>
    <label htmlFor="miniq-data-directory">当前目录
      <input id="miniq-data-directory" value={info?.path ?? "正在读取…"} readOnly />
    </label>
    {info?.managedByEnvironment && <p className="settings-section-description">当前目录由 MINIQ_DATA_DIR 环境变量管理，不能在应用内更换。</p>}
    <button type="button" className="secondary" disabled={busy || !info || info.managedByEnvironment} onClick={() => void changeDirectory()}>
      {busy ? "正在迁移数据…" : "更换数据目录"}
    </button>
    {status && <p role="status">{status}</p>}
  </section>;
}