import { throwIfAborted } from "./abortSignal";
import type { RpcClient } from "./rpc";
import type { SignedDownload } from "./remoteTransfer";
type Entry = { ticket?: SignedDownload; pending?: Promise<SignedDownload> };
const clients = new WeakMap<Pick<RpcClient, "call">, Map<string, Entry>>();
const keyOf = (client: Pick<RpcClient, "call">, session: string, path: string, revision: string) => {
  const authority = client as Partial<Pick<RpcClient, "targetDeviceId" | "storageScope">>;
  return JSON.stringify([authority.storageScope, authority.targetDeviceId, session, path, revision]);
};
function waitForTicket(promise: Promise<SignedDownload>, signal?: AbortSignal): Promise<SignedDownload> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException("Request cancelled", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, cause => { cleanup(); reject(cause); });
    if (signal.aborted) abort();
  });
}
export async function cachedDownloadTicket(client: Pick<RpcClient, "call">, session: string, path: string, revision: string, force: boolean, request: () => Promise<SignedDownload>, signal?: AbortSignal): Promise<SignedDownload> {
  throwIfAborted(signal);
  let cache = clients.get(client);
  if (!cache) { cache = new Map(); clients.set(client, cache); }
  const key = keyOf(client, session, path, revision);
  const wait = async (promise: Promise<SignedDownload>) => {
    const ticket = await waitForTicket(promise, signal);
    if (keyOf(client, session, path, revision) !== key)
      throw new Error("目标电脑已变化，请重新打开文件");
    return { ...ticket };
  };
  const existing = cache.get(key);
  if (existing?.pending) return wait(existing.pending);
  if (!force && existing?.ticket && existing.ticket.expiresAt > Date.now() + 5000) return { ...existing.ticket };
  // Bound retained tickets; evicting an in-flight entry does not cancel its users.
  for (const [id, item] of cache) if (!item.pending && (!item.ticket || item.ticket.expiresAt <= Date.now())) cache.delete(id);
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  const entry: Entry = {};
  const store = cache;
  store.set(key, entry);
  entry.pending = request().then(ticket => {
    entry.ticket = ticket;
    entry.pending = undefined;
    return ticket;
  }, cause => {
    if (store.get(key) === entry) store.delete(key);
    throw cause;
  });
  return wait(entry.pending);
}
export function invalidateDownloadTicket(client: Pick<RpcClient, "call">, session: string, path: string, revision: string, ticket: SignedDownload): void {
  const cache = clients.get(client); const key = keyOf(client, session, path, revision);
  if (cache?.get(key)?.ticket?.getUrl === ticket.getUrl) cache.delete(key);
}
