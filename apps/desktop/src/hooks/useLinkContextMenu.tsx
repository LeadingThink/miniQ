import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { FileContextMenu } from "../components/FileContextMenu";
import { LinkContextMenu } from "../components/LinkContextMenu";
import { useToast } from "../components/ui/Toast";
import { downloadFileToDevice } from "../linkActions";
import type { LocalFileTarget } from "../localFiles";
import { resolveMarkdownLinkTarget, type MarkdownLinkTarget } from "../markdownLinkTarget";
import { isTauriRuntime } from "../runtime";
import { useSessionFileAccess } from "../sessionFileAccess";

export function useLinkContextMenu(options: {
  workspacePath?: string | null;
  workspacePaths?: readonly string[];
  onOpenFile?: (target: LocalFileTarget) => void;
  onOpenUrl?: (url: string) => void;
  onError?: (message: string) => void;
}) {
  const access = useSessionFileAccess();
  const toast = useToast();
  const anchor = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<{ scope: string; target: MarkdownLinkTarget; point: { x: number; y: number } | null } | null>(null);
  const close = useCallback(() => setState(null), []);
  const workspacePath = access?.workspacePath ?? options.workspacePath;
  const workspacePaths = access?.workspacePaths ?? options.workspacePaths ?? [];
  const local = isTauriRuntime() && access?.client?.mode !== "remote";
  const scopeKey = JSON.stringify([access?.sessionId, access?.client?.mode, workspacePath, workspacePaths]);
  const open = (element: HTMLElement, point: { x: number; y: number } | null) => {
    let target: MarkdownLinkTarget | null;
    if (element.dataset.filePath) {
      target = { kind: "file", target: {
        path: element.dataset.filePath,
        line: Number(element.dataset.fileLine) || null,
        column: Number(element.dataset.fileColumn) || null,
      } };
    } else {
      target = resolveMarkdownLinkTarget(element.getAttribute("href") ?? "", workspacePath);
    }
    if (!target) return false;
    anchor.current = element;
    setState({ target, point, scope: scopeKey });
    return true;
  };
  const elementFor = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-file-path],a[href]") : null;
    return element && event.currentTarget.contains(element) ? element : null;
  };
  const reportError = (message: string) => {
    if (options.onError) options.onError(message);
    else toast.show({ message, tone: "danger" });
  };
  const target = state?.scope === scopeKey ? state.target : null;
  return {
    openAt: (element: HTMLElement, point: { x: number; y: number } | null) => open(element, point),
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      const element = elementFor(event);
      if (element && open(element, { x: event.clientX, y: event.clientY })) {
        event.preventDefault(); event.stopPropagation();
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      const element = elementFor(event);
      if (element && open(element, null)) { event.preventDefault(); event.stopPropagation(); }
    },
    menu: target?.kind === "file" ? <FileContextMenu
      key={target.target.path} variant="link" target={{ path: target.target.path, directory: anchor.current?.dataset.fileDirectory === "true" }}
      anchorRef={anchor} point={state!.point} onClose={close} local={local}
      roots={[workspacePath, ...workspacePaths]} workspacePath={workspacePath} workspacePaths={workspacePaths}
      authorizedFiles={access?.authorizedFiles} onOpen={options.onOpenFile ? () => options.onOpenFile?.(target.target) : undefined}
      onDownload={!local && access?.client && access.sessionId ? () => downloadFileToDevice(target.target.path, access) : undefined}
      onError={reportError}
    /> : target?.kind === "url" ? <LinkContextMenu url={target.url} anchorRef={anchor} point={state!.point}
      onClose={close} onOpenUrl={access?.client?.mode !== "remote" ? options.onOpenUrl : undefined} onError={reportError} /> : null,
  };
}
