import { useEffect, useState, type RefObject } from "react";
import { addPathToChat, copyText, relativePath, revealInFinder } from "../fileActions";
import { isTextPreviewFile, openLocalFile } from "../localFiles";
import { fileOpenApplications, fileText, openLocalFileWith, revealFileLabel, saveLocalFileAs, type FileOpenApplication } from "../linkActions";
import { useSessionFileAccess } from "../sessionFileAccess";
import { Menu, MenuItem, MenuSeparator, MenuSubmenu } from "./ui/Menu";
import "./LinkContextMenu.css";

export interface FileContextTarget { path: string; directory: boolean }

export interface FileContextMenuProps {
  target: FileContextTarget | null;
  anchorRef: RefObject<HTMLElement | null>;
  point?: { x: number; y: number } | null;
  onClose: () => void;
  roots: readonly (string | null | undefined)[];
  local: boolean;
  workspacePath?: string | null;
  workspacePaths?: readonly string[];
  authorizedFiles?: readonly string[];
  onOpen?: (path: string) => void;
  onDownload?: () => Promise<void>;
  onError?: (message: string) => void;
  variant?: "link" | "tree";
}

/** File tree, Markdown references and delivered files share these actions. */
export function FileContextMenu(props: FileContextMenuProps) {
  const { target } = props;
  const access = useSessionFileAccess();
  const [applications, setApplications] = useState<FileOpenApplication[]>([]);
  const path = target?.path;
  const directory = target?.directory;
  const scope = {
    workspacePath: props.workspacePath,
    workspacePaths: props.workspacePaths,
    authorizedFiles: props.authorizedFiles,
  };
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    let cancelled = false;
    setApplications([]);
    if (path && !directory && props.local && props.workspacePath) {
      void fileOpenApplications(path, JSON.parse(scopeKey)).then((items) => {
        if (!cancelled) setApplications(items);
      }).catch(() => { /* Open/save actions report permission and file errors. */ });
    }
    return () => { cancelled = true; };
  }, [path, directory, props.local, props.workspacePath, scopeKey]);
  const run = (action: () => void | Promise<unknown>) => {
    const failed = (cause: unknown) => props.onError?.(cause instanceof Error ? cause.message : String(cause));
    try { void Promise.resolve(action()).catch(failed); } catch (cause) { failed(cause); }
  };
  if (!target) return null;
  const defaultApp = applications.find((application) => application.isDefault);
  const tree = props.variant !== "link";
  return <Menu open anchorRef={props.anchorRef} point={props.point} onClose={props.onClose}
    label={directory ? "文件夹操作" : "文件操作"} className="link-context-menu file-context-menu">
    {!directory && props.onOpen && <MenuItem onClick={() => props.onOpen?.(target.path)}>
      {tree ? "打开" : "打开文件"}
    </MenuItem>}
    {props.local && <MenuItem onClick={() => run(() => openLocalFile(target.path, scope.workspacePath, scope.workspacePaths, scope.authorizedFiles))}>
      {defaultApp ? `在 ${defaultApp.name} 中打开` : "用默认应用打开"}
    </MenuItem>}
    {!directory && applications.length > 0 && <MenuSubmenu label="打开方式" className="link-context-menu">
      {applications.map((application) => <MenuItem key={application.id}
        onClick={() => run(() => openLocalFileWith(target.path, application.id, scope))}>
        {application.name}{application.isDefault ? "（默认）" : ""}
      </MenuItem>)}
    </MenuSubmenu>}
    {(props.onOpen || props.local) && <MenuSeparator />}
    {!directory && props.local && <MenuItem onClick={() => run(() => saveLocalFileAs(target.path, scope))}>另存为…</MenuItem>}
    {!directory && props.onDownload && <MenuItem onClick={() => run(props.onDownload!)}>下载到当前设备</MenuItem>}
    <MenuItem onClick={() => run(() => copyText(target.path))}>复制路径</MenuItem>
    {!directory && isTextPreviewFile(target.path) && (props.local || access?.client) &&
      <MenuItem onClick={() => run(async () => copyText(await fileText(target.path, scope, access)))}>复制文件内容</MenuItem>}
    {props.local && <MenuItem onClick={() => run(() => revealInFinder(target.path, { ...scope, directory }))}>
      {revealFileLabel()}
    </MenuItem>}
    {tree && <>
      <MenuSeparator />
      <MenuItem onClick={() => run(() => copyText(relativePath(target.path, props.roots)))}>复制相对路径</MenuItem>
      <MenuItem onClick={() => addPathToChat(target.path, props.roots)}>添加到聊天</MenuItem>
    </>}
  </Menu>;
}
