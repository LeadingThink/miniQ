import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeCompanionNavigation, type CompanionDestination } from "../companionBridge";
import { useDesktopHost } from "../desktopHost";
import { hostKey } from "../hostWorkspace";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import type { Catalog, NavigationState } from "./useMiniqApp";

type Request = { destination: CompanionDestination; switching?: boolean; refreshing?: boolean; refreshed?: boolean };

/** The persistent local controller owns this subscription, including while SSH is visible. */
export function useCompanionNavigation({ client, catalog, navigation, active, connectionEpoch, openSession, selectWorkspace, setError }: {
  client: RpcClient;
  catalog: Catalog;
  navigation: NavigationState;
  active: boolean;
  connectionEpoch: number;
  openSession: (id: string) => Promise<void>;
  selectWorkspace: (id: string) => void;
  setError: (message: string | null) => void;
}) {
  const desktop = useDesktopHost();
  const [request, setRequest] = useState<Request | null>(null);
  const [voiceRequest, setVoiceRequest] = useState<{ id: number; workspaceId: string; sessionId: string | null }>();
  const voiceSequence = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (client.sshHost) return;
    return subscribeCompanionNavigation((destination) => setRequest({ destination }));
  }, [client]);
  useEffect(() => {
    if (!request || connectionEpoch === 0) return;
    if (client.mode !== "local" || client.sshHost || client.targetDeviceId) {
      setRequest(null);
      setError("桌面伙伴只能打开本机项目和会话，不能导航到远程电脑");
      return;
    }
    if (desktop && desktop.host !== null) {
      if (!request.switching) {
        request.switching = true;
        void desktop.selectHost(null).catch((cause) => {
          if (mounted.current) { setRequest(null); setError(errorMessage(cause)); }
        });
      }
      return;
    }
    if (!active) return;
    const target = request.destination;
    if (target.action === "settings") {
      setRequest(null);
      navigation.openSettings("services");
      return;
    }
    // Epoch is set only after initial catalogs load. Desktop refreshes have their own readiness.
    if (desktop && desktop.catalogs[hostKey(null)]?.catalogStatus !== "ready") return;
    if (!request.refreshed) {
      if (!request.refreshing) {
        request.refreshing = true;
        void Promise.all([catalog.refreshWorkspaces(), catalog.refreshSessions()]).then(() => {
          if (mounted.current) setRequest((current) => current === request ? { ...request, refreshed: true } : current);
        }).catch((cause) => {
          if (mounted.current) {
            setRequest((current) => current === request ? null : current);
            setError(`无法读取本机项目和会话：${errorMessage(cause)}`);
          }
        });
      }
      return;
    }
    const workspace = catalog.workspaces.find((item) => item.id === target.workspaceId);
    const session = target.sessionId ? catalog.sessions.find((item) => item.id === target.sessionId) : null;
    setRequest(null);
    if (!workspace || (target.sessionId && (!session || session.workspaceId !== workspace.id || session.external || session.archived))) {
      setError("伙伴指定的本机项目或会话不存在，或会话不属于该项目");
      return;
    }
    navigation.setShowSettings(false);
    navigation.setShowSearch(false);
    navigation.setPage(null);
    if (session) void openSession(session.id);
    else selectWorkspace(workspace.id);
    if (target.action === "voice") setVoiceRequest({ id: ++voiceSequence.current, workspaceId: workspace.id, sessionId: session?.id ?? null });
  }, [request, desktop, active, client, connectionEpoch, catalog, navigation, openSession, selectWorkspace, setError]);
  const voiceHandled = useCallback((id: number) => {
    setVoiceRequest((current) => current?.id === id ? undefined : current);
  }, []);
  useEffect(() => {
    if (voiceRequest && (!active || catalog.currentSessionId !== voiceRequest.sessionId
      || (!voiceRequest.sessionId && catalog.selectedWorkspaceId !== voiceRequest.workspaceId))) setVoiceRequest(undefined);
  }, [active, catalog.currentSessionId, catalog.selectedWorkspaceId, voiceRequest]);
  return { voiceRequest, voiceHandled };
}
