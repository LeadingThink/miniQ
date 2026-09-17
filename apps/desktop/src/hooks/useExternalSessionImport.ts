import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import type {
  ExternalProvider,
  ExternalSessionImportJob,
  ExternalSessionScan,
} from "../types";
import {
  EXTERNAL_PROVIDERS,
  externalSessionKey,
  filterExternalSessions,
  toggleSelectedKeys,
} from "../components/externalSessionImportModel";

interface ExternalImportStateInput {
  client: RpcClient;
  onImported: () => Promise<void>;
}

export function useExternalSessionImport(input: ExternalImportStateInput) {
  const [scan, setScan] = useState<ExternalSessionScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [providers, setProviders] = useState<Set<ExternalProvider>>(
    new Set(EXTERNAL_PROVIDERS),
  );
  const [workspaceId, setWorkspaceId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<ExternalSessionImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notifiedJob = useRef<string | null>(null);
  const importing = submitting || job?.state === "running";
  const result = job?.result ?? null;

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await input.client.call<ExternalSessionScan>("externalSession.scan");
      setScan(response);
      setSelected(new Set());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [input.client]);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  useEffect(() => {
    if (!job || job.state !== "running") return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await input.client.call<ExternalSessionImportJob>(
          "externalSession.importStatus",
          { jobId: job.id },
        );
        if (!active) return;
        if (next.state === "failed") {
          setError(next.failure ?? "导入任务失败");
          setJob(null);
          return;
        }
        setError(null);
        setJob(next);
        if (next.state === "running") timer = window.setTimeout(poll, 500);
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        timer = window.setTimeout(poll, 1_000);
      }
    };
    timer = window.setTimeout(poll, 250);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [input.client, job?.id, job?.state]);

  useEffect(() => {
    if (!job?.result || notifiedJob.current === job.id) return;
    notifiedJob.current = job.id;
    void input.onImported().catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [input.onImported, job?.id, job?.result]);

  const visible = useMemo(
    () => filterExternalSessions(scan?.sessions ?? [], providers, search),
    [providers, scan?.sessions, search],
  );
  const visibleKeys = useMemo(() => visible.map(externalSessionKey), [visible]);
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((key) => selected.has(key));

  const startImport = async (
    sessions: ExternalSessionScan["sessions"],
    targetWorkspaceId: string | null,
  ) => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await input.client.call<ExternalSessionImportJob>(
        "externalSession.import",
        {
          sessions: sessions.map((session) => ({
            provider: session.provider,
            externalId: session.externalId,
            sourcePath: session.sourcePath,
            workspaceId: targetWorkspaceId,
          })),
        },
      );
      setJob(response);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const importSelected = async () => {
    if (!scan || selected.size === 0) return;
    await startImport(
      scan.sessions.filter((session) => selected.has(externalSessionKey(session))),
      workspaceId || null,
    );
  };

  const retryableFailures = result?.errors.filter(
    (item) => item.workspaceRequired && item.externalId,
  ) ?? [];
  const retryWorkspaceFailures = async () => {
    if (!scan || !workspaceId || retryableFailures.length === 0) return;
    const failed = new Set(
      retryableFailures.flatMap((item) => (
        item.externalId
          ? [externalSessionKey({ provider: item.provider, externalId: item.externalId })]
          : []
      )),
    );
    await startImport(
      scan.sessions.filter((session) => failed.has(externalSessionKey(session))),
      workspaceId,
    );
  };

  const toggleAll = (checked: boolean) => {
    setSelected((current) => toggleSelectedKeys(current, visibleKeys, checked));
  };
  const toggleOne = (key: string, checked: boolean) => {
    setSelected((current) => toggleSelectedKeys(current, [key], checked));
  };

  return {
    scan,
    selected,
    providers,
    workspaceId,
    search,
    loading,
    importing,
    job,
    error,
    result,
    retryableFailureCount: retryableFailures.length,
    visible,
    allVisibleSelected,
    setProviders,
    setWorkspaceId,
    setSearch,
    runScan,
    importSelected,
    retryWorkspaceFailures,
    toggleAll,
    toggleOne,
  };
}

export type ExternalSessionImportState = ReturnType<typeof useExternalSessionImport>;
