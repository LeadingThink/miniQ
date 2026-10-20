import { mkdtemp, mkdir, open, readdir, rm } from "node:fs/promises";
import { openAsBlob } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/** Real temporary disk bytes behind the small OPFS surface used by uploads. */
export async function installUploadFileSystem() {
  const root = await mkdtemp(join(tmpdir(), "miniq-upload-test-"));
  const writes: number[] = [];
  const removed: string[] = [];
  let beforeWrite: (() => void) | undefined;
  const directory = (path: string): unknown => ({
    async getDirectoryHandle(name: string) {
      const child = join(path, name);
      await mkdir(child, { recursive: true });
      return directory(child);
    },
    async getFileHandle(name: string) {
      const child = join(path, name);
      return {
        async createWritable() {
          const handle = await open(child, "w");
          return {
            async write(bytes: Uint8Array) { beforeWrite?.(); writes.push(bytes.byteLength); await handle.writeFile(bytes); },
            async close() { await handle.close(); },
            async abort() { await handle.close(); },
          };
        },
        async getFile() { return new File([await openAsBlob(child)], name); },
      };
    },
    async removeEntry(name: string) { removed.push(name); await rm(join(path, name), { force: true, recursive: true }); },
    async *keys() { for (const entry of await readdir(path)) yield entry; },
  });
  vi.stubGlobal("navigator", { storage: { getDirectory: vi.fn(async () => directory(root)) } });
  return {
    writes, removed,
    beforeWrite(callback: () => void) { beforeWrite = callback; },
    async entries() { return readdir(root, { recursive: true }); },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}
