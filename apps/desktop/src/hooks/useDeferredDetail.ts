import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import { errorMessage } from "../errorMessage";

// Successful details survive a fold unmount; connections own separate caches.
// Bound retained payloads without retaining clients after disconnect.
const caches = new WeakMap<RpcClient, Map<string, unknown>>();
export function useDeferredDetail<T>(
  client: RpcClient | undefined,
  method: string,
  params: Record<string, unknown>,
  version: unknown,
  enabled: boolean,
) {
  const host = client?.sshHost ?? null;
  const key = JSON.stringify([method, params, version, host]);
  const [result, setResult] = useState<{ client: RpcClient; key: string; value?: T; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current = result && result.client === client && result.key === key ? result : null;
  const cached = client ? caches.get(client)?.get(key) as T | undefined : undefined;
  const value = cached ?? current?.value;
  const loaded = value !== undefined;
  useEffect(() => {
    if (!enabled || !client || loaded || caches.get(client)?.has(key)) return;
    const controller = new AbortController();
    // The serialized request is also the dependency, so equivalent parent
    // renders never cancel and restart an in-flight page.
    const [, requestParams] = JSON.parse(key);
    void client.call<T>(method, requestParams, { signal: controller.signal }).then((value) => {
      if (controller.signal.aborted || (client.sshHost ?? null) !== host) return;
      const serialized = JSON.stringify(value);
      if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength <= 1024 * 1024) {
        let cache = caches.get(client);
        if (!cache) caches.set(client, cache = new Map());
        cache.set(key, value);
        if (cache.size > 64) cache.delete(cache.keys().next().value!);
      }
      setResult({ client, key, value });
    }).catch((cause) => {
      if (!controller.signal.aborted && (client.sshHost ?? null) === host) setResult({ client, key, error: errorMessage(cause) });
    });
    return () => controller.abort();
  }, [client, key, method, host, loaded, enabled, attempt]);
  return {
    value,
    error: current?.error,
    loading: enabled && !!client && value === undefined && !current?.error,
    retry: () => { setResult(null); setAttempt((value) => value + 1); },
  };
}
