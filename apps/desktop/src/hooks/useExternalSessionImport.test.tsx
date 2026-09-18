// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type {
  ExternalSessionImportJob,
  ExternalSessionScan,
} from "../types";
import { useExternalSessionImport } from "./useExternalSessionImport";

const scan: ExternalSessionScan = {
  providers: [{
    provider: "codex",
    root: "C:/Users/test/.codex",
    available: true,
    sessionCount: 1,
    messageCount: 2,
    error: null,
  }],
  sessions: [{
    provider: "codex",
    externalId: "external-1",
    title: "Imported title",
    cwd: "C:/work",
    sourcePath: "C:/Users/test/.codex/session.jsonl",
    messageCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:02Z",
    continuationMode: "recreate_only",
  }],
  errors: [],
};

function job(state: ExternalSessionImportJob["state"]): ExternalSessionImportJob {
  const complete = state === "completed";
  return {
    id: "import-1",
    state,
    totalSessions: 1,
    processedSessions: complete ? 1 : 0,
    importedMessages: complete ? 2 : 0,
    errorCount: 0,
    result: complete ? {
      importedSessionIds: ["session-1"],
      importedMessages: 2,
      errors: [],
    } : null,
    failure: null,
  };
}

afterEach(cleanup);

describe("useExternalSessionImport", () => {
  it("starts a background import and polls until completion", async () => {
    const onImported = vi.fn(async () => {});
    const call = vi.fn(async (method: string) => {
      if (method === "externalSession.scan") return scan;
      if (method === "externalSession.import") return job("running");
      if (method === "externalSession.importStatus") return job("completed");
      throw new Error(`unexpected method ${method}`);
    });
    const input = { client: { call } as unknown as RpcClient, onImported };
    const hook = renderHook(() => useExternalSessionImport(input));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    act(() => hook.result.current.toggleOne("codex\u0000external-1", true));
    await act(async () => hook.result.current.importSelected());
    expect(hook.result.current.importing).toBe(true);

    await waitFor(() => expect(hook.result.current.result?.importedMessages).toBe(2), {
      timeout: 2_000,
    });
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith("externalSession.importStatus", { jobId: "import-1" });
    expect(call).toHaveBeenCalledWith("externalSession.import", {
      sessions: [{
        provider: "codex",
        externalId: "external-1",
        sourcePath: "C:/Users/test/.codex/session.jsonl",
        workspaceId: null,
      }],
    });
  });

  it("retries only workspace failures in the selected miniQ project", async () => {
    const onImported = vi.fn(async () => {});
    let importAttempt = 0;
    const failed: ExternalSessionImportJob = {
      ...job("completed"),
      result: {
        importedSessionIds: [],
        importedMessages: 0,
        errors: [{
          provider: "codex",
          externalId: "external-1",
          workspaceRequired: true,
          message: "missing directory",
        }],
      },
      errorCount: 1,
    };
    const call = vi.fn(async (method: string, params?: { jobId?: string }) => {
      if (method === "externalSession.scan") return scan;
      if (method === "externalSession.import") {
        importAttempt += 1;
        return { ...job("running"), id: `import-${importAttempt}` };
      }
      if (method === "externalSession.importStatus") {
        return params?.jobId === "import-1"
          ? failed
          : { ...job("completed"), id: "import-2" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const input = {
      client: { call } as unknown as RpcClient,
      onImported,
    };
    const hook = renderHook(() => useExternalSessionImport(input));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    act(() => hook.result.current.toggleOne("codex\u0000external-1", true));
    await act(async () => hook.result.current.importSelected());
    await waitFor(() => expect(hook.result.current.retryableFailureCount).toBe(1));

    act(() => hook.result.current.setWorkspaceId("workspace-2"));
    await act(async () => hook.result.current.retryWorkspaceFailures());
    await waitFor(() => expect(hook.result.current.result?.importedMessages).toBe(2));

    const importCalls = call.mock.calls.filter(([method]) => method === "externalSession.import");
    expect(importCalls).toHaveLength(2);
    expect(importCalls[1][1]).toEqual({
      sessions: [{
        provider: "codex",
        externalId: "external-1",
        sourcePath: "C:/Users/test/.codex/session.jsonl",
        workspaceId: "workspace-2",
      }],
    });
  });
});
