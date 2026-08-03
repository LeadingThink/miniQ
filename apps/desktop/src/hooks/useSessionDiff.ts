import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import type { SessionDiff, ToolCall } from "../types";

const WRITE_TOOLS = new Set(["file_write", "file_edit", "doc_write", "file_patch"]);
const EMPTY_DIFF: SessionDiff = { files: [], additions: 0, deletions: 0 };

function writeRevision(toolCalls: ToolCall[]): string {
  return toolCalls
    .filter((call) => WRITE_TOOLS.has(call.toolName))
    .map((call) => `${call.id}:${call.status}`)
    .join("|");
}

export function useSessionDiff(
  client: RpcClient,
  sessionId: string | null,
  toolCalls: ToolCall[],
) {
  const [data, setData] = useState<SessionDiff>(EMPTY_DIFF);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const revision = useMemo(() => writeRevision(toolCalls), [toolCalls]);

  const refresh = useCallback(async () => {
    const requestId = ++requestSequence.current;
    if (!sessionId) {
      setData(EMPTY_DIFF);
      setOpen(false);
      setError(null);
      return;
    }
    try {
      const result = await client.call<SessionDiff>("session.diff", { sessionId });
      if (requestId !== requestSequence.current) return;
      setData(result);
      setError(null);
      if (result.files.length === 0) setOpen(false);
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setError(errorMessage(cause));
    }
  }, [client, sessionId]);

  useEffect(() => {
    requestSequence.current += 1;
    setData(EMPTY_DIFF);
    setOpen(false);
    setError(null);
  }, [client, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  return {
    data,
    error,
    open: open && data.files.length > 0,
    setOpen,
    refresh,
  };
}
