import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { RpcClient } from "./rpc";
import type { FileReadOptions } from "./remoteFiles";

const Context = createContext<FileReadOptions | undefined>(undefined);

export function SessionFileAccess({
  client,
  sessionId,
  children,
}: {
  client: RpcClient;
  sessionId: string | null;
  children: ReactNode;
}) {
  const access = useMemo(() => ({ client, sessionId }), [client, sessionId]);
  return <Context.Provider value={access}>{children}</Context.Provider>;
}

export const useSessionFileAccess = () => useContext(Context);
