// Downloads wallpaper loops on first use and keeps the most recent ones in
// IndexedDB, so later launches play offline without hitting the CDN.

const DB_NAME = "miniq-backgrounds";
const STORE = "videos";
const MAX_CACHED = 6;

interface CachedVideo {
  url: string;
  blob: Blob;
  savedAt: number;
}

const inflight = new Map<string, Promise<Blob>>();

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase | null> | undefined;
function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "url" });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function readCached(url: string): Promise<Blob | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  try {
    const entry = await request<CachedVideo | undefined>(db.transaction(STORE).objectStore(STORE).get(url));
    return entry?.blob?.size ? entry.blob : undefined;
  } catch {
    return undefined;
  }
}

async function writeCached(url: string, blob: Blob) {
  const db = await openDb();
  if (!db) return;
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await request(store.put({ url, blob, savedAt: Date.now() } satisfies CachedVideo));
    const entries = await request<CachedVideo[]>(store.getAll());
    const stale = entries.sort((a, b) => b.savedAt - a.savedAt).slice(MAX_CACHED);
    await Promise.all(stale.map((entry) => request(store.delete(entry.url))));
  } catch {
    // Caching is best effort; playback still works from memory.
  }
}

async function download(url: string): Promise<Blob> {
  const cached = await readCached(url);
  if (cached) return cached;
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`background video ${response.status}`);
  const blob = await response.blob();
  if (!blob.size) throw new Error("background video is empty");
  await writeCached(url, blob);
  return blob;
}

/** Resolves the wallpaper loop from the local cache, downloading it once if needed. */
export function loadBackgroundVideo(url: string): Promise<Blob> {
  let pending = inflight.get(url);
  if (!pending) {
    pending = download(url).finally(() => inflight.delete(url));
    inflight.set(url, pending);
  }
  return pending;
}

/** Test hook: forget the shared database handle. */
export function resetBackgroundVideoCache() {
  dbPromise = undefined;
  inflight.clear();
}
