import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import type { AgentSummary } from "../components/AgentSummary";

const ACTIVE = new Set(["running", "stopping", "finalizing"]);

/**
 * Fetches the compact child-agent list for one exact session.  The hook only
 * polls while work is active (or the daemon is busy), so remote sessions do
 * not pull full tool histories or keep a relay request alive unnecessarily.
 */
export function useAgentSummary(
  client: RpcClient,
  sessionId: string,
  busy: boolean,
  enabled = true,
) {
  const [snapshot, setSnapshot] = useState<{
    client: RpcClient;
    sessionId: string;
    agents: AgentSummary[];
    error: string | null;
  } | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    let inFlight = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      if (stale || document.visibilityState === "hidden") return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, delay);
    };
    const refresh = async () => {
      if (stale) return;
      if (inFlight) {
        queued = true;
        return;
      }
      if (document.visibilityState === "hidden") return;
      inFlight = true;
      let nextDelay: number | null = null;
      try {
        const response = await client.call<{ agents: AgentSummary[] }>(
          "agent.list",
          { sessionId },
        );
        if (stale) return;
        setSnapshot({ client, sessionId, agents: response.agents, error: null });
        if (busy || response.agents.some((agent) => ACTIVE.has(agent.status))) {
          nextDelay = 2500;
        }
      } catch (cause) {
        if (!stale) {
          setSnapshot((previous) => ({
            client,
            sessionId,
            agents: previous?.client === client && previous.sessionId === sessionId
              ? previous.agents : [],
            error: String(cause),
          }));
          // Keep a disconnected remote view recoverable without tight polling.
          nextDelay = 5000;
        }
      } finally {
        inFlight = false;
        if (stale) return;
        if (queued) {
          queued = false;
          schedule(0);
        } else if (nextDelay !== null) {
          schedule(nextDelay);
        }
      }
    };
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
      else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const reconnect = client.onStatus((connected) => {
      if (!stale && connected) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        void refresh();
      }
    });
    return () => {
      stale = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      reconnect();
    };
  }, [client, sessionId, busy, revision, enabled]);

  const current = snapshot?.client === client && snapshot.sessionId === sessionId
    ? snapshot : null;
  return {
    agents: current?.agents ?? [],
    error: current?.error ?? null,
    refresh: () => setRevision((value) => value + 1),
  };
}
