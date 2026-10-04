/** Independent of background policy so storage can be used without a policy cycle. */
export interface PersistentMobileVideoCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  dbName?: string;
  /** null explicitly selects the in-memory backend. */
  indexedDB?: IDBFactory | null;
}

export interface PersistentMobileVideoCache {
  readonly maxEntries: number;
  readonly maxBytes: number;
  get(key: string): Promise<Blob | undefined>;
  put(key: string, blob: Blob): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  stats(): Promise<{ entries: number; bytes: number }>;
  /** Last committed snapshot seen by this instance; use stats/get to refresh it. */
  getStatus(): { items: number; bytes: number; maxEntries: number; maxBytes: number };
  peek(key: string): Blob | undefined;
}

type Entry = { key: string; blob: Blob; used: number };
const STORE = "videos";
// Share call ordering between instances, including while the database is opening.
const queues = new WeakMap<IDBFactory, Map<string, Promise<unknown>>>();

export function createPersistentMobileVideoCache(
  options: PersistentMobileVideoCacheOptions = {},
): PersistentMobileVideoCache {
  const maxEntries = options.maxEntries ?? 3;
  const maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("Mobile video cache limits must be positive safe integers");
  }
  const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
  const dbName = options.dbName ?? "miniq-mobile-video-cache";
  let snapshot = new Map<string, Entry>();
  let memoryQueue: Promise<unknown> = Promise.resolve();
  const totals = (entries: Map<string, Entry>) => ({
    entries: entries.size,
    bytes: [...entries.values()].reduce((sum, entry) => sum + entry.blob.size, 0),
  });

  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = factory!.open(dbName, 1);
      let failed = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Opening mobile video cache failed"));
      request.onblocked = () => {
        failed = true;
        reject(new Error("Opening mobile video cache was blocked"));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }

  function run<T>(mutate: boolean, operation: (entries: Map<string, Entry>) => T): Promise<T> {
    const execute = async (): Promise<T> => {
      if (!factory) {
        const entries = new Map([...snapshot].map(([key, entry]) => [key, { ...entry }]));
        const result = operation(entries);
        snapshot = entries;
        return result;
      }
      const db = await open();
      try {
        return await new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE, mutate ? "readwrite" : "readonly");
          let result: T;
          let entries: Map<string, Entry>;
          let operationError: unknown;
          tx.onabort = () => reject(operationError ?? tx.error ?? new Error("Mobile video cache transaction aborted"));
          tx.onerror = () => { /* onabort reports the final transaction failure */ };
          tx.oncomplete = () => { snapshot = entries; resolve(result); };
          const store = tx.objectStore(STORE);
          const request = store.getAll();
          request.onsuccess = () => {
            try {
              entries = new Map((request.result as Entry[]).map(entry => [entry.key, entry]));
              result = operation(entries);
              if (mutate) {
                // All replacement and eviction work stays in this transaction. No await
                // inside request handlers: Safari may otherwise auto-commit the tx.
                store.clear();
                for (const entry of entries.values()) store.put(entry);
              }
            } catch (error) {
              operationError = error;
              tx.abort();
            }
          };
        });
      } finally {
        db.close();
      }
    };
    if (!factory) {
      const result = memoryQueue.then(execute);
      memoryQueue = result.catch(() => undefined);
      return result;
    }
    let queue = queues.get(factory);
    if (!queue) { queue = new Map(); queues.set(factory, queue); }
    const result = (queue.get(dbName) ?? Promise.resolve()).then(execute);
    const tail = result.catch(() => undefined);
    queue.set(dbName, tail);
    void tail.then(() => { if (queue.get(dbName) === tail) queue.delete(dbName); });
    return result;
  }

  const touch = (entries: Map<string, Entry>, key: string, blob: Blob) => {
    // Logical access order avoids clock changes and same-millisecond LRU ties.
    const ordered = [...entries.values()].filter(entry => entry.key !== key)
      .sort((a, b) => a.used - b.used);
    ordered.push({ key, blob, used: 0 });
    entries.clear();
    ordered.forEach((entry, used) => entries.set(entry.key, { ...entry, used }));
    let bytes = totals(entries).bytes;
    for (const entry of entries.values()) {
      if (entries.size <= maxEntries && bytes <= maxBytes) break;
      entries.delete(entry.key);
      bytes -= entry.blob.size;
    }
  };

  return {
    maxEntries, maxBytes,
    get: key => run(true, entries => {
      const blob = entries.get(key)?.blob;
      if (blob) touch(entries, key, blob);
      return blob;
    }),
    put: (key, blob) => run(true, entries => {
      if (blob.size > maxBytes) throw new RangeError("Video exceeds the mobile video cache byte limit");
      touch(entries, key, blob);
    }),
    remove: key => run(true, entries => { entries.delete(key); }),
    clear: () => run(true, entries => { entries.clear(); }),
    stats: () => run(false, totals),
    peek: key => snapshot.get(key)?.blob,
    getStatus: () => ({ items: snapshot.size, bytes: totals(snapshot).bytes, maxEntries, maxBytes }),
  };
}
