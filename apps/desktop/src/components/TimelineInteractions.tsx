import { useState } from "react";
import {
  Check,
  Copy,
  Ellipsis,
  Eye,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideoCamera,
  FolderOpen,
  BookOpen,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { fileExtension, fileTypeInfo, type FileType as DeliveredFileType } from "../fileTypes";
import type { Artifact } from "../types";
import type { PendingApproval } from "../App";
import { ToolPayload } from "./ToolPayload";
import { isTauriRuntime } from "../runtime";
import { useSessionFileAccess } from "../sessionFileAccess";
import {
  resolveWorkspacePath,
  type LocalFileTarget,
} from "../localFiles";
import { copyText, revealInFinder } from "../fileActions";
import { fileReferenceAttributes } from "../markdownLinkTarget";
import { revealFileLabel } from "../linkActions";
import { useLinkContextMenu } from "../hooks/useLinkContextMenu";
import "./ArtifactCard.css";

export function ApprovalCard({
  item,
  onResolve,
  pending = false,
  allowAlways,
}: {
  item: PendingApproval;
  onResolve: (approvalId: string, decision: string) => void;
  pending?: boolean;
  /** Overrides the context-derived default (e.g. the approval inbox). */
  allowAlways?: boolean;
}) {
  // "Always allow" persists a host-wide rule, so it is desktop-only (plan v3 D16).
  const contextRemote = useSessionFileAccess()?.client?.mode === "remote";
  const isRemote = allowAlways === undefined ? contextRemote : !allowAlways;
  return (
    <div className="card approval-card" data-approval-id={item.approval.id}>
      <div className="card-head">
        <span>需要审批</span>
        <span className="tool-name">{item.toolName}</span>
        <span className={`badge ${item.approval.riskLevel}`}>
          {item.approval.riskLevel}
        </span>
      </div>
      <div style={{ marginTop: 6 }}>{item.approval.reason}</div>
      <ToolPayload label="待审批参数" value={item.input} />
      <div className="approval-actions">
        <button
          disabled={pending}
          onClick={() => onResolve(item.approval.id, "approve")}
        >
          允许一次
        </button>
        <button
          className="secondary"
          disabled={pending}
          onClick={() => onResolve(item.approval.id, "approve_for_session")}
        >
          本会话允许
        </button>
        {!isRemote && (
          <button
            className="secondary"
            disabled={pending}
            title="以后此工具（同一来源与版本）不再询问，可在插件页撤销"
            onClick={() => onResolve(item.approval.id, "always_allow_tool")}
          >
            总是允许
          </button>
        )}
        <button
          disabled={pending}
          className="danger"
          onClick={() => onResolve(item.approval.id, "reject")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

const FILE_TYPE_ICONS: Record<DeliveredFileType, LucideIcon> = {
  pdf: FileText,
  word: FileType,
  excel: FileSpreadsheet,
  ppt: Presentation,
  image: FileImage,
  audio: FileMusic,
  video: FileVideoCamera,
  archive: FileArchive,
  markdown: FileText,
  html: FileCode,
  text: FileText,
  ebook: BookOpen,
  other: File,
};

/** Breadcrumb segments for a delivered path, without inventing a missing drive. */
function pathCrumbs(path: string): { key: string; label: string }[] {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^[A-Za-z]:/.exec(normalized)?.[0];
  const body = drive ? normalized.slice(drive.length) : normalized;
  const parts = body.split("/").filter(Boolean);
  if (parts.length > 1) parts.pop();
  const labels = drive ? [drive, ...parts] : parts;
  return labels.map((label, index) => ({
    key: `${index}:${label}`,
    label,
  }));
}

export function ArtifactCard(props: {
  workspacePaths?: readonly string[];
  artifact: Artifact;
  workspacePath?: string | null;
  onOpenFile: (target: LocalFileTarget) => void;
  onError: (message: string) => void;
}) {
  const { artifact, workspacePath, onOpenFile, onError } = props;
  const access = useSessionFileAccess();
  const local = isTauriRuntime() && access?.client?.mode !== "remote";
  const path = resolveWorkspacePath(artifact.path, workspacePath);
  const linkMenu = useLinkContextMenu(props);
  const [copied, setCopied] = useState(false);
  const fileType = fileTypeInfo(path ?? artifact.path, artifact.kind);
  const Icon = FILE_TYPE_ICONS[fileType.type];
  const extension = fileExtension(path ?? artifact.path);
  const crumbs = pathCrumbs(path ?? artifact.path);
  const directory = artifact.kind === "directory";
  const fileRef = path
    ? { ...fileReferenceAttributes({ path, line: null, column: null }), "data-file-directory": directory ? "true" : undefined }
    : {};
  const openFile = () => {
    if (path) onOpenFile({ path, line: null, column: null });
  };
  const reveal = () => {
    if (!path) return;
    void revealInFinder(path, {
      directory,
      workspacePath,
      workspacePaths: props.workspacePaths,
    }).catch((cause) => {
      onError(`无法在文件夹中显示：${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };
  const copyPath = () => {
    if (!path) return;
    void copyText(path).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch((cause) => {
      onError(`无法复制路径：${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };
  const openMore = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect();
    linkMenu.openAt(element, { x: rect.left, y: rect.bottom });
  };
  return (
    <section className="artifact-card" aria-label="交付产物" onContextMenu={linkMenu.onContextMenu} onKeyDown={linkMenu.onKeyDown}>
      <div className="artifact-card-meta">
        <span className="artifact-card-status">
          <span className="artifact-card-status-dot" aria-hidden="true" />
          交付产物
        </span>
        <span className="artifact-card-format">{fileType.label}</span>
      </div>
      <div className="artifact-item" title={path ?? artifact.path}>
        <div className="artifact-file">
          <span className={`artifact-file-icon is-${fileType.type}`} aria-hidden="true">
            <Icon size={20} />
            {extension && <span className="artifact-file-ext">.{extension}</span>}
          </span>
          <div className="artifact-file-copy">
            <div className="artifact-file-name">
              <button
                type="button"
                className="artifact-open artifact-title"
                aria-label={`打开 ${artifact.title}`}
                disabled={!path}
                {...fileRef}
                onClick={openFile}
              >
                {artifact.title}
              </button>
              <span className="artifact-ready">
                <Check size={12} aria-hidden="true" />
                已就绪
              </span>
            </div>
            {crumbs.length > 0 && (
              <div className="artifact-crumbs">
                {crumbs.map((crumb, index) => (
                  <span key={crumb.key} className="artifact-crumb">
                    {index > 0 && <span className="artifact-crumb-sep" aria-hidden="true">/</span>}
                    <span className={index === crumbs.length - 1 ? "is-current" : undefined}>{crumb.label}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="artifact-actions">
          <button
            type="button"
            className="artifact-preview"
            disabled={!path}
            {...fileRef}
            onClick={openFile}
          >
            <Eye size={14} aria-hidden="true" />
            预览
          </button>
          {local && (
            <button
              type="button"
              className="icon-button"
              aria-label={`在文件夹中显示 ${artifact.title}`}
              title={revealFileLabel()}
              disabled={!path}
              onClick={reveal}
            >
              <FolderOpen size={14} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={`复制路径 ${artifact.title}`}
            title={copied ? "已复制" : "复制完整路径"}
            disabled={!path}
            onClick={copyPath}
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`更多操作 ${artifact.title}`}
            title="更多操作"
            disabled={!path}
            {...fileRef}
            onClick={(event) => openMore(event.currentTarget)}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {linkMenu.menu}
    </section>
  );
}
