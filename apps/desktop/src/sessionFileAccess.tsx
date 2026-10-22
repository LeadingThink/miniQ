import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { RpcClient } from "./rpc";
import type { FileReadOptions } from "./remoteFiles";

export interface SessionFileScope extends FileReadOptions {
  workspacePath?: string | null;
  workspacePaths?: readonly string[];
  authorizedFiles?: readonly string[];
}

const Context = createContext<SessionFileScope | undefined>(undefined);

export function SessionFileAccess({
  client,
  sessionId,
  workspacePath,
  workspacePaths,
  authorizedFiles,
  children,
}: {
  client: RpcClient;
  sessionId: string | null;
  workspacePath?: string | null;
  workspacePaths?: readonly string[];
  authorizedFiles?: readonly string[];
  children: ReactNode;
}) {
  const access = useMemo(() => ({ client, sessionId, workspacePath, workspacePaths, authorizedFiles }),
    [client, sessionId, workspacePath, workspacePaths, authorizedFiles]);
  return <Context.Provider value={access}>{children}</Context.Provider>;
}

export const useSessionFileAccess = () => useContext(Context);
