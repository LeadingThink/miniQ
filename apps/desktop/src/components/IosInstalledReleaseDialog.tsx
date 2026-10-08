import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { iosInstalledReleaseNotices, type InstalledReleaseNotice } from "../iosInstalledReleaseNotice";

export function IosInstalledReleaseDialog({ notice, onClose }: { notice: InstalledReleaseNotice; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    // Another modal may have opened between queue selection and React commit.
    if (document.querySelector("dialog[open]")) { onClose(); return; }
    element.showModal();
    iosInstalledReleaseNotices.markShown(notice.version);
    button.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [notice.version]);
  return createPortal(<dialog ref={dialog} className="mobile-update-dialog" aria-labelledby={title}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id={title}>已更新至 {notice.version}</h2>
    <h3>本次更新说明</h3>
    {notice.releaseNotes.length ? <ul>{notice.releaseNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>
      : <p>你已安装此版本。暂未获取到此版本的详细更新说明。</p>}
    <footer><button type="button" ref={button} className="primary" onClick={onClose}>开始使用</button></footer>
  </dialog>, document.body);
}
