import {
  ClipboardCopy,
  Code2,
  FileText,
  FolderOpen,
  MessageSquarePlus,
} from "lucide-react";
import type { RefObject } from "react";
import { openInEditor, type ExternalEditor } from "../externalEditor";
import { addPathToChat, copyText, relativePath, revealInFinder } from "../fileActions";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";

export const EXTERNAL_EDITORS: ReadonlyArray<{ id: ExternalEditor; label: string }> = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
];

export interface FileContextTarget {
  path: string;
  directory: boolean;
}

export interface FileContextMenuProps {
  target: FileContextTarget | null;
  anchorRef: RefObject<HTMLElement | null>;
  /** Pointer position for mouse-triggered menus; omitted for keyboard-triggered ones. */
  point?: { x: number; y: number } | null;
  onClose: () => void;
  /** Roots used for relative paths and chat mentions. */
  roots: readonly (string | null | undefined)[];
  /** Local desktop session: enables Finder and external-editor items. */
  local: boolean;
  workspacePath?: string | null;
  workspacePaths?: readonly string[];
  authorizedFiles?: readonly string[];
  onOpen?: (path: string) => void;
  onError?: (message: string) => void;
}

/** Right-click / Shift+F10 actions for a file-tree entry. */
export function FileContextMenu(props: FileContextMenuProps) {
  const { target } = props;
  const run = (action: () => void | Promise<void>) => {
    void (async () => {
      try {
        await action();
      } catch (cause) {
        props.onError?.(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  };
  if (!target) return null;
  const { path, directory } = target;
  const relative = relativePath(path, props.roots);
  return (
    <Menu
      open
      anchorRef={props.anchorRef}
      point={props.point}
      onClose={props.onClose}
      label={directory ? "文件夹操作" : "文件操作"}
      className="file-context-menu"
    >
      {!directory && props.onOpen && (
        <MenuItem icon={<FileText size={14} />} onClick={() => props.onOpen?.(path)}>
          打开
        </MenuItem>
      )}
      <MenuItem
        icon={<MessageSquarePlus size={14} />}
        onClick={() => addPathToChat(path, props.roots)}
      >
        添加到聊天
      </MenuItem>
      <MenuSeparator />
      {props.local && (
        <MenuItem
          icon={<FolderOpen size={14} />}
          onClick={() =>
            run(() =>
              revealInFinder(path, {
                directory,
                workspacePath: props.workspacePath,
                workspacePaths: props.workspacePaths,
                authorizedFiles: props.authorizedFiles,
              }),
            )
          }
        >
          在 Finder 中显示
        </MenuItem>
      )}
      <MenuItem icon={<ClipboardCopy size={14} />} onClick={() => run(() => copyText(path))}>
        复制路径
      </MenuItem>
      <MenuItem icon={<ClipboardCopy size={14} />} onClick={() => run(() => copyText(relative))}>
        复制相对路径
      </MenuItem>
      {!directory && props.local && (
        <>
          <MenuSeparator />
          {EXTERNAL_EDITORS.map((editor) => (
            <MenuItem
              key={editor.id}
              icon={<Code2 size={14} />}
              onClick={() => run(() => openInEditor({ path }, editor.id))}
            >
              用 {editor.label} 打开
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}
