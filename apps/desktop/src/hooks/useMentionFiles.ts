import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import type { RemoteDirectory } from "../remoteFiles";
import type { MentionFile } from "../composerMention";
import { errorMessage } from "../errorMessage";

/** Breadth-first scan bounds; the popover must stay responsive on big repos. */
const SCAN_DIRECTORIES = 80;
const SCAN_DEPTH = 6;
const SCAN_PAGES = 5;
const SCAN_FILES = 5000;
const CACHE_MS = 30_000;
const SKIP = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "vendor",
  "Pods",
  "DerivedData",
  "__pycache__",
  "venv",
]);

type Scan = { at: number; promise: Promise<MentionFile[]> };
const cache = new WeakMap<RpcClient, Map<string, Scan>>();

async function scanFiles(client: RpcClient, sessionId: string): Promise<MentionFile[]> {
  const files: MentionFile[] = [];
  const queue: Array<[string, number]> = [["", 0]];
  let directories = 0;
  while (queue.length && directories < SCAN_DIRECTORIES && files.length < SCAN_FILES) {
    const [dir, depth] = queue.shift()!;
    directories += 1;
    let after: string | null = null;
    for (let page = 0; page < SCAN_PAGES; page += 1) {
      let listing: RemoteDirectory;
      try {
        listing = await client.call<RemoteDirectory>("file.list", { sessionId, path: dir, after });
      } catch (cause) {
        if (dir === "") throw cause;
        break; // Unreadable subfolders are skipped; the root error is reported.
      }
      for (const entry of listing.entries) {
        if (entry.unavailable) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.directory) {
          if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
          files.push({ path: `${path}/`, directory: true });
          if (depth + 1 < SCAN_DEPTH) queue.push([path, depth + 1]);
        } else {
          files.push({ path, directory: false });
        }
      }
      after = listing.nextCursor;
      if (!after) break;
    }
  }
  return files;
}

function cachedScan(client: RpcClient, sessionId: string): Promise<MentionFile[]> {
  let byClient = cache.get(client);
  if (!byClient) {
    byClient = new Map();
    cache.set(client, byClient);
  }
  const current = byClient.get(sessionId);
  if (current && Date.now() - current.at < CACHE_MS) return current.promise;
  const promise = scanFiles(client, sessionId);
  const entry = { at: Date.now(), promise };
  byClient.set(sessionId, entry);
  // Failed scans are retried on the next activation.
  promise.catch(() => {
    if (byClient!.get(sessionId) === entry) byClient!.delete(sessionId);
  });
  return promise;
}

/** Lists the session's project files while the @ popover is open. */
export function useMentionFiles(
  client: RpcClient | undefined,
  sessionId: string | undefined,
  active: boolean,
) {
  const [state, setState] = useState<{
    key: string;
    files: MentionFile[];
    loading: boolean;
    error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = sessionId ?? "";
  useEffect(() => {
    if (!active || !client || !sessionId) return;
    let stale = false;
    setState((current) =>
      current?.key === sessionId && !current.error
        ? current
        : { key: sessionId, files: [], loading: true, error: null },
    );
    cachedScan(client, sessionId).then(
      (files) => {
        if (!stale) setState({ key: sessionId, files, loading: false, error: null });
      },
      (cause) => {
        if (!stale) setState({ key: sessionId, files: [], loading: false, error: errorMessage(cause) });
      },
    );
    return () => {
      stale = true;
    };
  }, [active, client, sessionId, attempt]);
  const current = state?.key === key ? state : null;
  return {
    files: current?.files ?? [],
    loading: current?.loading ?? (active && !!client && !!sessionId),
    error: current?.error ?? null,
    retry: () => setAttempt((value) => value + 1),
  };
}

export const __test = { clear: (client: RpcClient) => cache.delete(client) };
