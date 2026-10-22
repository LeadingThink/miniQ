import { AppWindow, Copy, Download, Globe, Link, Square } from "lucide-react";
import type { RefObject } from "react";
import { copyText } from "../fileActions";
import { openExternalUrl, openLinkWindow, saveExternalLinkAs } from "../linkActions";
import { isTauriRuntime } from "../runtime";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import "./LinkContextMenu.css";

export function LinkContextMenu(props: {
  url: string;
  anchorRef: RefObject<HTMLElement | null>;
  point: { x: number; y: number } | null;
  onClose: () => void;
  onOpenUrl?: (url: string) => void;
  onError: (message: string) => void;
}) {
  const web = /^https?:/i.test(props.url);
  const run = (action: () => void | Promise<unknown>) => {
    try {
      // Keep window.open and clipboard calls inside the user's activation.
      void Promise.resolve(action()).catch((cause) => props.onError(String(cause instanceof Error ? cause.message : cause)));
    } catch (cause) { props.onError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <Menu open anchorRef={props.anchorRef} point={props.point} onClose={props.onClose}
    label="链接操作" className="link-context-menu">
    {web && <div className="link-context-menu-heading">在以下位置打开</div>}
    {web && props.onOpenUrl && <MenuItem icon={<Square size={17} />} onClick={() => props.onOpenUrl?.(props.url)}>新标签页</MenuItem>}
    {web && <MenuItem icon={<AppWindow size={17} />} onClick={() => run(() => openLinkWindow(props.url))}>新窗口</MenuItem>}
    <MenuItem icon={web ? <Globe size={18} /> : <Link size={18} />} onClick={() => run(() => openExternalUrl(props.url))}>
      {web ? "默认浏览器" : "打开链接"}
    </MenuItem>
    <MenuSeparator />
    <MenuItem icon={<Copy size={17} />} onClick={() => run(() => copyText(props.url))}>复制链接</MenuItem>
    {web && isTauriRuntime() && <MenuItem icon={<Download size={18} />} onClick={() => run(() => saveExternalLinkAs(props.url))}>链接另存为…</MenuItem>}
  </Menu>;
}
