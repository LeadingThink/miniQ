import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../rpc";
import type {
  ExternalProvider,
  ExternalSessionImportResult,
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
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExternalSessionImportResult | null>(null);

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

  const visible = useMemo(
    () => filterExternalSessions(scan?.sessions ?? [], providers, search),
    [providers, scan?.sessions, search],
  );
  const visibleKeys = useMemo(() => visible.map(externalSessionKey), [visible]);
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((key) => selected.has(key));

  const importSelected = async () => {
    if (!scan || selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const sessions = scan.sessions
        .filter((session) => selected.has(externalSessionKey(session)))
        .map((session) => ({
          provider: session.provider,
          externalId: session.externalId,
          sourcePath: session.sourcePath,
          workspaceId: workspaceId || null,
        }));
      const response = await input.client.call<ExternalSessionImportResult>(
        "externalSession.import",
        { sessions },
      );
      setResult(response);
      await input.onImported();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
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
    error,
    result,
    visible,
    allVisibleSelected,
    setProviders,
    setWorkspaceId,
    setSearch,
    runScan,
    importSelected,
    toggleAll,
    toggleOne,
  };
}

export type ExternalSessionImportState = ReturnType<typeof useExternalSessionImport>;
