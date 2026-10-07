import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { clearRemoteCredentials, type RemoteCredentials } from "./remoteAccess";
import { clearSelectedDesktop, loadSelectedDesktop, rememberSelectedDesktop, type RemoteDesktop } from "./remoteDevices";
import { useRemoteDevices } from "./hooks/useRemoteDevices";
import { RemoteDevicePicker } from "./components/RemoteDevicePicker";
import { DesktopHostProvider, useDesktopHost } from "./desktopHost";
import { RpcClient } from "./rpc";
import { dismissTaskBanner, type TaskNotificationTarget } from "./taskBanner";
import type { ThemeId } from "./theme";
import { hostKey } from "./hostWorkspace";
import "./RemoteWorkbench.css";

const ConnectedApp = lazy(() => import("./ConnectedApp"));

type PendingNotification = { target: TaskNotificationTarget; signal: AbortSignal };

function NotificationDestination({ notification }: { notification: PendingNotification | null }) {
  const target = notification?.target;
  const desktop = useDesktopHost();
  const [opened, setOpened] = useState<TaskNotificationTarget | null>(null);
  useEffect(() => {
    if (!target || notification?.signal.aborted || opened === target || !desktop || target.targetDeviceId !== desktop.root.targetDeviceId) return;
    if (desktop.catalogs[hostKey(null)]?.catalogStatus !== "ready") return;
    setOpened(target);
    desktop.openSession(target, notification?.signal);
  }, [target, notification, opened, desktop]);
  return null;
}

function DeviceWorkbench({ credentials, device, scope, theme, onThemeChange, notification }: {
  credentials: RemoteCredentials; device: RemoteDesktop; scope: string; theme: ThemeId; onThemeChange: (theme: ThemeId) => void;
  notification: PendingNotification | null;
}) {
  const [root] = useState(() => new RpcClient({ ...credentials, kind: "remote", targetDeviceId: device.id }, JSON.stringify([scope, device.id]) + ":"));
  useEffect(() => () => { root.disconnect("selected computer changed"); dismissTaskBanner(); }, [root]);
  return <DesktopHostProvider root={root}><NotificationDestination notification={notification} /><Suspense fallback={<main>正在加载远程工作台…</main>}>
    <ConnectedApp theme={theme} onThemeChange={onThemeChange} />
  </Suspense></DesktopHostProvider>;
}

export function RemoteWorkbench({ credentials, theme, onThemeChange, onExit }: {
  credentials: RemoteCredentials; theme: ThemeId; onThemeChange: (theme: ThemeId) => void; onExit?: () => void;
}) {
  const directory = useRemoteDevices(credentials);
  const [selected, setSelected] = useState<RemoteDesktop | null>(null);
  const [restoredScope, setRestoredScope] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [notification, setNotification] = useState<PendingNotification | null>(null);
  const notificationController = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!directory.scope || restoredScope === directory.scope) return;
    setSelected(loadSelectedDesktop(directory.scope));
    setRestoredScope(directory.scope);
  }, [directory.scope, restoredScope]);
  useEffect(() => {
    const receive = (event: Event) => {
      const target = (event as CustomEvent<TaskNotificationTarget>).detail;
      notificationController.current?.abort();
      notificationController.current = null;
      if (!target?.targetDeviceId) { setNotification(null); setNotice("这条通知未标明电脑，请手动选择电脑查看。"); setChoosing(true); return; }
      const controller = new AbortController();
      notificationController.current = controller;
      setNotification({ target, signal: controller.signal });
      setNotice("这条通知来自另一台电脑，请选择对应电脑查看。");
      setChoosing(true);
    };
    window.addEventListener("miniq:remote-notification-target", receive);
    return () => { notificationController.current?.abort(); window.removeEventListener("miniq:remote-notification-target", receive); };
  }, []);
  const current = directory.devices.find((device) => device.id === selected?.id) ?? (selected ? { ...selected, online: false } : null);
  const choose = (device: RemoteDesktop) => {
    if (!directory.scope) return;
    rememberSelectedDesktop(directory.scope, device);
    dismissTaskBanner();
    setSelected(device); setChoosing(false); setNotice("");
    if (notification?.target.targetDeviceId !== device.id) { notificationController.current?.abort(); setNotification(null); }
  };
  return <div className="remote-workbench">
    <header className="remote-desktop-bar"><button type="button" onClick={() => setChoosing((value) => !value)} aria-expanded={choosing || !current}>
      {current?.name || "选择连接的电脑"}<span>{directory.error || directory.loading ? "状态待确认" : current?.online ? "在线" : current ? "离线" : ""} · 切换电脑</span>
    </button></header>
    {notice && <p role="status">{notice}</p>}
    {(choosing || !current) && <div className="remote-device-panel"><RemoteDevicePicker devices={directory.devices} selected={current} loading={directory.loading} error={directory.error} onSelect={choose} onRefresh={directory.refresh} />
      <button type="button" onClick={() => { if (directory.scope) clearSelectedDesktop(directory.scope); void clearRemoteCredentials().then(() => onExit?.()); }}>更换 Key</button>
      {current && <button type="button" onClick={() => setChoosing(false)}>返回当前电脑</button>}
    </div>}
    {current && directory.scope && <div className="remote-workbench-content" hidden={choosing}>
      {!current.online && !directory.loading && !directory.error && <div className="remote-offline-notice" role="status">{current.name} 当前离线，正在等待这台电脑恢复。你也可以点击顶部手动切换电脑。</div>}
      <DeviceWorkbench key={`${directory.scope}:${current.id}`} credentials={credentials} device={current} scope={directory.scope} theme={theme} onThemeChange={onThemeChange} notification={notification} />
    </div>}
  </div>;
}
