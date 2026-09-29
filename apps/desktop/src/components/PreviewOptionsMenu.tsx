import {
  ClipboardCopy,
  FileText,
  FolderOpen,
  ListOrdered,
  MoreHorizontal,
  Search,
} from "lucide-react";
import { useRef, useState } from "react";
import { copyText, relativePath } from "../fileActions";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";

export interface PreviewOptionsMenuProps {
  path: string;
  roots: readonly (string | null | undefined)[];
  /** Text content, when loaded; enables "复制文件内容". */
  content: string | null;
  /** Local desktop session: show "在 Finder 中显示". */
  onReveal?: () => Promise<void>;
  /** Source editor visible: enable go-to-line and find. */
  onGoToLine?: () => void;
  onFind?: () => void;
  onError?: (message: string) => void;
}

const isApple = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** Secondary preview actions collected behind a "更多" button. */
export function PreviewOptionsMenu(props: PreviewOptionsMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const apple = isApple();
  const run = (action: () => void | Promise<void>) => {
    void (async () => {
      try {
        await action();
      } catch (cause) {
        props.onError?.(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        title="更多"
        aria-label="更多文件操作"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!props.path}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={16} />
      </button>
      <Menu
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        label="更多文件操作"
      >
        <MenuItem icon={<ClipboardCopy size={14} />} onClick={() => run(() => copyText(props.path))}>
          复制路径
        </MenuItem>
        <MenuItem
          icon={<ClipboardCopy size={14} />}
          onClick={() => run(() => copyText(relativePath(props.path, props.roots)))}
        >
          复制相对路径
        </MenuItem>
        <MenuItem
          icon={<FileText size={14} />}
          disabled={props.content === null}
          onClick={() => run(() => copyText(props.content ?? ""))}
        >
          复制文件内容
        </MenuItem>
        {props.onReveal && (
          <MenuItem icon={<FolderOpen size={14} />} onClick={() => run(props.onReveal!)}>
            在 Finder 中显示
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem
          icon={<ListOrdered size={14} />}
          shortcut={apple ? "⌘L" : "Ctrl+G"}
          disabled={!props.onGoToLine}
          onClick={() => props.onGoToLine?.()}
        >
          转到行
        </MenuItem>
        <MenuItem
          icon={<Search size={14} />}
          shortcut={apple ? "⌘F" : "Ctrl+F"}
          disabled={!props.onFind}
          onClick={() => props.onFind?.()}
        >
          在文件中查找
        </MenuItem>
      </Menu>
    </>
  );
}
