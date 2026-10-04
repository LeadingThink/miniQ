import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentMobileVideoCache } from "./mobileVideoCache";

// Transactional test driver: writes are isolated until completion and discarded
// on abort. Completion is a separate task from request success, as in IndexedDB.
function databaseDriver() {
  type Row = { key: string; blob: Blob; used: number };
  const databases = new Map<string, Map<string, Row>>();
  let failCommit = false;
  let failOpen = false;
  let blocked = false;
  let committed = 0;
  let beforeCommit: (() => void) | undefined;
  const close = vi.fn();
  const factory = {
    open(name: string) {
      const request = {} as IDBOpenDBRequest;
      setTimeout(() => {
        if (failOpen) {
          Object.assign(request, { error: new DOMException("Open denied", "SecurityError") });
          request.onerror?.(new Event("error"));
          return;
        }
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const db = {
          close,
          objectStoreNames: { contains: () => !fresh },
          createObjectStore: vi.fn(),
          transaction() {
            const staged = new Map([...databases.get(name)!].map(([key, row]) => [key, { ...row }]));
            let aborted = false;
            let active = false;
            const tx = {
              onabort: null, oncomplete: null, onerror: null,
              abort() {
                aborted = true;
                setTimeout(() => (tx as unknown as IDBTransaction).onabort?.(new Event("abort")), 0);
              },
              objectStore() {
                return {
                  getAll() {
                    const read = {} as IDBRequest<Row[]>;
                    setTimeout(() => {
                      Object.assign(read, { result: [...staged.values()] });
                      active = true;
                      read.onsuccess?.(new Event("success"));
                      active = false;
                      setTimeout(() => {
                        if (aborted) return;
                        beforeCommit?.();
                        if (failCommit) {
                          failCommit = false;
                          Object.assign(tx, { error: new DOMException("Quota exhausted", "QuotaExceededError") });
                          tx.abort();
                        } else {
                          databases.set(name, staged);
                          committed++;
                          (tx as unknown as IDBTransaction).oncomplete?.(new Event("complete"));
                        }
                      }, 0);
                    }, 0);
                    return read;
                  },
                  clear() {
                    if (!active) throw new DOMException("Inactive transaction", "TransactionInactiveError");
                    staged.clear();
                  },
                  put(row: Row) {
                    if (!active) throw new DOMException("Inactive transaction", "TransactionInactiveError");
                    staged.set(row.key, { ...row });
                  },
                };
              },
            };
            return tx;
          },
        };
        Object.assign(request, { result: db });
        if (blocked) request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
        if (fresh) request.onupgradeneeded?.(new Event("upgradeneeded") as IDBVersionChangeEvent);
        request.onsuccess?.(new Event("success"));
      }, 0);
      return request;
    },
  } as unknown as IDBFactory;
  return {
    factory, close,
    get committed() { return committed; },
    failCommit: () => { failCommit = true; },
    failOpen: () => { failOpen = true; },
    block: () => { blocked = true; },
    beforeCommit: (callback: () => void) => { beforeCommit = callback; },
  };
}
const blob = (text: string) => new Blob([text], { type: "video/mp4" });
afterEach(() => vi.unstubAllGlobals());

for (const backend of ["memory", "indexedDB"] as const) {
  describe(backend, () => {
    const cache = (limits = {}) => createPersistentMobileVideoCache({
      indexedDB: backend === "memory" ? null : databaseDriver().factory,
      ...limits,
    });
    it("uses bounded defaults and counts real Blob bytes", async () => {
      const c = cache();
      expect(c.maxEntries).toBe(3);
      expect(c.maxBytes).toBe(24 * 1024 * 1024);
      await c.put("unicode", blob("你好"));
      expect(await c.stats()).toEqual({ entries: 1, bytes: 6 });
      expect((await c.get("unicode"))?.type).toBe("video/mp4");
      expect(c.getStatus()).toEqual({ items: 1, bytes: 6, maxEntries: 3, maxBytes: 24 * 1024 * 1024 });
      expect(c.peek("unicode")?.size).toBe(6);
    });
    it("touches reads and replacements for LRU, with no clock dependency", async () => {
      const c = cache({ maxEntries: 2 });
      await c.put("a", blob("a"));
      await c.put("b", blob("b"));
      await c.get("a");
      await c.put("c", blob("c"));
      expect(await c.get("b")).toBeUndefined();
      await c.put("a", blob("aa"));
      await c.put("d", blob("d"));
      expect(await c.get("c")).toBeUndefined();
      expect(await c.stats()).toEqual({ entries: 2, bytes: 3 });
    });
    it("evicts for bytes and rejects an oversized replacement without losing data", async () => {
      const c = cache({ maxBytes: 5 });
      await c.put("a", blob("aa"));
      await c.put("b", blob("bb"));
      await c.put("c", blob("ccc"));
      expect(await c.get("a")).toBeUndefined();
      await expect(c.put("b", blob("123456"))).rejects.toThrow(/byte limit/);
      expect(await (await c.get("b"))?.text()).toBe("bb");
      expect(await c.stats()).toEqual({ entries: 2, bytes: 5 });
      await c.put("c", blob("c"));
      expect(await c.stats()).toEqual({ entries: 2, bytes: 3 });
    });
    it("orders racing writes, remove, clear and later writes", async () => {
      const c = cache();
      await Promise.all([
        c.put("a", blob("a")), c.remove("a"), c.put("b", blob("b")),
        c.clear(), c.put("survivor", blob("ok")),
      ]);
      expect(await c.get("a")).toBeUndefined();
      expect(await c.get("b")).toBeUndefined();
      expect(await c.stats()).toEqual({ entries: 1, bytes: 2 });
      await c.remove("survivor");
      await c.remove("missing");
      expect(await c.stats()).toEqual({ entries: 0, bytes: 0 });
    });
  });
}

it("persists blobs and LRU across instances, serializing calls while opening", async () => {
  const driver = databaseDriver();
  const a = createPersistentMobileVideoCache({ indexedDB: driver.factory, maxEntries: 2 });
  const b = createPersistentMobileVideoCache({ indexedDB: driver.factory, maxEntries: 2 });
  await Promise.all([a.put("a", blob("a")), b.put("b", blob("b"))]);
  expect(await (await b.get("a"))?.text()).toBe("a");
  await a.put("c", blob("c"));
  expect(await b.get("b")).toBeUndefined();
  await Promise.all([a.put("race", blob("race")), b.clear(), a.put("last", blob("last"))]);
  expect(await b.stats()).toEqual({ entries: 1, bytes: 4 });
  await Promise.all([a.put("race", blob("race")), b.remove("race")]);
  expect(await a.get("race")).toBeUndefined();
});

it("resolves only at commit, rejects transaction failure, rolls back and recovers", async () => {
  const driver = databaseDriver();
  const c = createPersistentMobileVideoCache({ indexedDB: driver.factory });
  await c.put("a", blob("a"));
  expect(driver.committed).toBe(1);
  driver.failCommit();
  await expect(c.clear()).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(c.peek("a")?.size).toBe(1);
  driver.failCommit();
  await expect(c.put("a", blob("replacement"))).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(await (await c.get("a"))?.text()).toBe("a");
  await c.put("b", blob("bb"));
  expect(await c.stats()).toEqual({ entries: 2, bytes: 3 });
  expect(driver.close).toHaveBeenCalledTimes(6);
});

it("keeps promises and snapshots pending between request success and transaction completion", async () => {
  const driver = databaseDriver();
  const c = createPersistentMobileVideoCache({ indexedDB: driver.factory });
  let settled = false;
  const observations: Array<{ settled: boolean; items: number }> = [];
  driver.beforeCommit(() => observations.push({ settled, items: c.getStatus().items }));
  const writing = c.put("a", blob("saved")).then(() => { settled = true; });
  await writing;
  expect(observations).toEqual([{ settled: false, items: 0 }]);
  expect(c.peek("a")?.size).toBe(5);
  settled = false;
  driver.failCommit();
  const clearing = c.clear().finally(() => { settled = true; });
  await expect(clearing).rejects.toMatchObject({ name: "QuotaExceededError" });
  expect(observations).toEqual([{ settled: false, items: 0 }, { settled: false, items: 1 }]);
  expect(c.peek("a")?.size).toBe(5);
});

it("reports opening and blocking failures instead of silently losing persistence", async () => {
  const denied = databaseDriver();
  denied.failOpen();
  const c = createPersistentMobileVideoCache({ indexedDB: denied.factory });
  await expect(c.put("a", blob("a"))).rejects.toMatchObject({ name: "SecurityError" });
  await expect(c.stats()).rejects.toMatchObject({ name: "SecurityError" });
  const blocked = databaseDriver();
  blocked.block();
  await expect(createPersistentMobileVideoCache({ indexedDB: blocked.factory }).stats()).rejects.toThrow(/blocked/);
  expect(blocked.close).toHaveBeenCalledOnce();
});

it("keeps the selected memory backend stable if IndexedDB appears later", async () => {
  vi.stubGlobal("indexedDB", undefined);
  const c = createPersistentMobileVideoCache();
  await c.put("a", blob("a"));
  vi.stubGlobal("indexedDB", databaseDriver().factory);
  expect(await (await c.get("a"))?.text()).toBe("a");
});

it("rejects invalid cache limits", () => {
  for (const maxEntries of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => createPersistentMobileVideoCache({ maxEntries })).toThrow(RangeError);
  }
  expect(() => createPersistentMobileVideoCache({ maxBytes: 0 })).toThrow(RangeError);
});
