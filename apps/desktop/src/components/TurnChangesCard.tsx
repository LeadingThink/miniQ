import { FileDiff as FileDiffIcon, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { FileDiff, SessionDiff } from "../types";
import {
  fetchTurnDiff,
  revertTurn,
  useTurnChanges,
  type TurnChangesContextValue,
  type TurnModifiedFile,
} from "../turnChanges";
import { Button, ConfirmDialog, Dialog, useToast } from "./ui";
import "./TurnChangesCard.css";

const VISIBLE_FILES = 3;

type DialogState = null | { kind: "confirm" } | { kind: "conflict"; files: TurnModifiedFile[] };

function fileBadge(file: FileDiff): string | null {
  if (!file.oldExists) return "新增";
  if (!file.newExists) return "已删除";
  if (file.binary) return "二进制";
  return null;
}

function useTurnDiff(context: TurnChangesContextValue | null, turnId: string) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const client = context?.client;
  const sessionId = context?.sessionId;
  const epoch = context?.epoch;
  useEffect(() => {
    if (!client || !sessionId) return;
    let cancelled = false;
    fetchTurnDiff(client, sessionId, turnId).then(
      (result) => { if (!cancelled) setDiff(result); },
      // The card is supplementary; the review panel reports load errors.
      () => { if (!cancelled) setDiff(null); },
    );
    return () => { cancelled = true; };
  }, [client, sessionId, turnId, epoch]);
  return diff;
}

function useTurnRevert(context: TurnChangesContextValue | null, turnId: string) {
  const toast = useToast();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [pending, setPending] = useState(false);
  const run = async (force: boolean) => {
    if (!context || pending) return;
    setPending(true);
    try {
      const result = await revertTurn(context.client, context.sessionId, turnId, force);
      if (!result.reverted) {
        setDialog({ kind: "conflict", files: result.modifiedFiles });
        return;
      }
      setDialog(null);
      context.onReverted();
      if (result.failedFiles.length) {
        toast.show({
          tone: "danger",
          message: `已撤销 ${result.restoredFiles.length} 个文件，${result.failedFiles.length} 个文件恢复失败：${
            result.failedFiles.map((file) => `${file.path}（${file.error}）`).join("、")}`,
        });
      } else {
        toast.show({ tone: "success", message: `已撤销本轮修改，恢复 ${result.restoredFiles.length} 个文件` });
      }
    } catch (cause) {
      setDialog(null);
      toast.show({ tone: "danger", message: `撤销失败：${errorMessage(cause)}` });
    } finally {
      setPending(false);
    }
  };
  return { dialog, setDialog, pending, run };
}

function ConflictDialog({ files, pending, onForce, onCancel }: {
  files: TurnModifiedFile[];
  pending: boolean;
  onForce: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open
      role="alertdialog"
      title="部分文件在本轮之后又被修改"
      description="继续撤销会覆盖这些文件的后续修改。"
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={onCancel}>取消</Button>
          <Button variant="danger" disabled={pending} onClick={onForce}>仍然撤销</Button>
        </>
      }
    >
      <ul className="turn-changes-conflicts">
        {files.map((file) => (
          <li key={file.absolutePath} title={file.absolutePath}>
            <code>{file.path}</code>
            <small>{file.reason === "modified" ? "本轮后被修改" : "无法确认是否被修改"}</small>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** Files one completed turn changed, with undo and review entry points. */
export function TurnChangesCard({ turnId }: { turnId: string }) {
  const context = useTurnChanges();
  const diff = useTurnDiff(context, turnId);
  const revert = useTurnRevert(context, turnId);
  const [expanded, setExpanded] = useState(false);
  if (!context || !diff || diff.files.length === 0) return null;
  const files = expanded ? diff.files : diff.files.slice(0, VISIBLE_FILES);
  const hidden = diff.files.length - files.length;
  return (
    <section className="turn-changes" aria-label="本轮文件改动">
      <header className="turn-changes-header">
        <div className="turn-changes-summary">
          <FileDiffIcon size={15} aria-hidden="true" />
          <span>已编辑 {diff.files.length} 个文件</span>
          <span className="diff-add">+{diff.additions}</span>
          <span className="diff-delete">-{diff.deletions}</span>
        </div>
        <div className="turn-changes-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<Undo2 size={14} />}
            disabled={context.busy || revert.pending}
            title={context.busy ? "任务运行中，结束后可撤销" : "撤销本轮所有文件修改"}
            onClick={() => revert.setDialog({ kind: "confirm" })}
          >
            撤销
          </Button>
          <Button variant="secondary" size="sm" onClick={() => context.openReview(turnId)}>
            查看变更
          </Button>
        </div>
      </header>
      <ul className="turn-changes-files">
        {files.map((file) => (
          <li key={file.absolutePath}>
            <button
              type="button"
              title={file.absolutePath}
              aria-label={`查看 ${file.path} 的变更`}
              onClick={() => context.openReview(turnId, file.path)}
            >
              <span className="turn-changes-path">{file.path}</span>
              {fileBadge(file) && <small>{fileBadge(file)}</small>}
              <span className="turn-changes-stats">
                <span className="diff-add">+{file.additions}</span>
                <span className="diff-delete">-{file.deletions}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="turn-changes-more" onClick={() => setExpanded(true)}>
          再显示 {hidden} 个文件
        </button>
      )}
      <ConfirmDialog
        open={revert.dialog?.kind === "confirm"}
        title="撤销本轮修改？"
        description={`将把本轮修改的 ${diff.files.length} 个文件恢复到本轮开始前的内容。`}
        confirmLabel="撤销"
        tone="danger"
        busy={revert.pending}
        onConfirm={() => void revert.run(false)}
        onCancel={() => revert.setDialog(null)}
      />
      {revert.dialog?.kind === "conflict" && (
        <ConflictDialog
          files={revert.dialog.files}
          pending={revert.pending}
          onForce={() => void revert.run(true)}
          onCancel={() => revert.setDialog(null)}
        />
      )}
    </section>
  );
}
