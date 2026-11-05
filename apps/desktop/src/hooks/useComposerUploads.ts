import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { composerUploads, type ComposerUploadItem } from "../composerUploads";
import type { RpcClient } from "../rpc";
import type { RemoteUploadScope } from "../remoteTransfer";

const EMPTY: ComposerUploadItem[] = [];
const emptySnapshot = () => EMPTY;
const emptySubscribe = () => () => {};

export function useComposerUploads(client: RpcClient | undefined, scope: RemoteUploadScope | undefined, draftKey: string | undefined, onAttach: (paths: string[]) => void) {
  const instance = useId();
  const scopeKey = scope ? "sessionId" in scope ? `session:${scope.sessionId}` : `workspace:${scope.workspaceId}` : "";
  const queue = useMemo(() => client?.mode === "remote" && scope
    ? composerUploads(client, `${scopeKey}:${draftKey ?? instance}`, scope) : undefined,
    // scopeKey carries the value identity of the wire scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, scopeKey, draftKey, instance]);
  if (queue) queue.onAttach = onAttach;
  const items = useSyncExternalStore(queue?.subscribe ?? emptySubscribe, queue?.getSnapshot ?? emptySnapshot);
  useEffect(() => () => queue?.pause(), [queue]);
  return { queue, items };
}
