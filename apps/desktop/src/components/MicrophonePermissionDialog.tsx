import { Mic, Settings, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { microphonePermissionGuidance, openMicrophoneSettings } from "../microphonePermission";
import "./MicrophonePermissionDialog.css";

export function MicrophonePermissionDialog(props: {
  disabled?: boolean;
  onClose: () => void;
  onRetry: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const [guidance] = useState(microphonePermissionGuidance);
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    active.current = true;
    const element = dialog.current!;
    element.showModal();
    (settingsButton.current ?? retryButton.current)?.focus();
    return () => { active.current = false; element.close(); };
  }, []);

  useEffect(() => {
    if (opening) return;
    if (opened) retryButton.current?.focus();
    else if (error) settingsButton.current?.focus();
  }, [opening, opened, error]);

  const openSettings = async () => {
    if (opening) return;
    setOpening(true); setError(false); setOpened(false);
    try {
      await openMicrophoneSettings();
      if (active.current) setOpened(true);
    } catch {
      if (active.current) setError(true);
    } finally {
      if (active.current) setOpening(false);
    }
  };

  return createPortal(<dialog ref={dialog} className="microphone-permission-dialog"
    aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <header>
      <Mic size={22} aria-hidden="true" />
      <h2 id={titleId}>允许使用麦克风</h2>
      <button type="button" className="close-button" aria-label="关闭麦克风权限提示" onClick={props.onClose}><X size={18} /></button>
    </header>
    <p id={descriptionId}>麦克风访问被拒绝，暂时无法开始语音输入。开启权限后即可继续，输入框中的内容会保留。</p>
    <ol>{guidance.steps.map((step) => <li key={step}>{step}</li>)}</ol>
    {error && <p role="alert">无法自动打开系统设置，请按上方路径手动开启权限。</p>}
    {opened && <p role="status">已请求打开系统设置。开启权限后，请返回并点击“已开启，重试”。</p>}
    <footer>
      <button type="button" onClick={props.onClose}>暂不使用</button>
      {guidance.canOpenSettings && <button type="button" className={opened ? "" : "primary"}
        ref={settingsButton} disabled={opening} onClick={() => void openSettings()}>
        <Settings size={15} aria-hidden="true" />{opening ? "正在打开…" : "打开系统设置"}
      </button>}
      <button type="button" className={opened || !guidance.canOpenSettings ? "primary" : ""}
        ref={retryButton} disabled={props.disabled || opening} onClick={props.onRetry}>已开启，重试</button>
    </footer>
  </dialog>, document.body);
}
