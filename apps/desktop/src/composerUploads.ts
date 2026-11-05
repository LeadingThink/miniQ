import type { RpcClient } from "./rpc";
import { uploadRemoteFile, type RemoteUploadScope } from "./remoteTransfer";
import { pickUploadSources, releaseUploadSources, stageBrowserUploadSources, type RemoteUploadSource } from "./remoteUploadSource";
import { stageDesktopUploadSources } from "./desktopUploadSource";
import { MAX_COMPOSER_ATTACHMENTS } from "./composerInput";
import { errorMessage } from "./errorMessage";
import { throwIfAborted } from "./abortSignal";

export type ComposerUploadSelection = File[] | { paths: string[] } | "files" | "photos";
export interface ComposerUploadItem {
  id: number;
  name: string;
  size?: number;
  state: "preparing" | "uploading" | "failed";
  progress: number;
  error?: string;
}
interface Entry extends ComposerUploadItem {
  input?: File | string;
  source?: RemoteUploadSource;
  controller?: AbortController;
  removed?: boolean;
  picker?: "files" | "photos";
  reserved?: number;
}

/** Pending originals stay with their draft, including failed uploads awaiting retry. */
export class ComposerUploads {
  private entries: Entry[] = [];
  private snapshot: ComposerUploadItem[] = [];
  private listeners = new Set<() => void>();
  private sequence = 0;
  private picking = false;
  private interruptions = 0;
  onAttach: (paths: string[]) => void = () => {};

  constructor(private client: RpcClient, private scope: RemoteUploadScope) {}

  getSnapshot = () => this.snapshot;
  get pendingCount() {
    return this.entries.reduce((count, entry) => count + (entry.state === "preparing" ? entry.reserved ?? 1 : 1), 0);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish() {
    this.snapshot = this.entries.map(({ id, name, size, state, progress, error }) => ({ id, name, size, state, progress, error }));
    for (const listener of this.listeners) listener();
  }

  private entry(name: string, input?: File | string, size?: number): Entry {
    return { id: ++this.sequence, name, input, size, state: "preparing", progress: 0 };
  }

  select(selection: ComposerUploadSelection, attachedCount: number): Promise<void> {
    if (this.picking) return Promise.reject(new Error("正在选择文件，请稍后再添加"));
    const limit = MAX_COMPOSER_ATTACHMENTS - attachedCount - this.entries.length;
    const inputs = typeof selection === "string" ? [] : Array.isArray(selection) ? selection : [...new Set(selection.paths)];
    if (limit <= 0 || inputs.length > limit) {
      return Promise.reject(new Error(`每条消息最多附加 ${MAX_COMPOSER_ATTACHMENTS} 个文件，请减少选择后重试`));
    }
    if (typeof selection !== "string" && !inputs.length) return Promise.resolve();
    const entries = typeof selection === "string" ? [{ ...this.entry("所选文件"), picker: selection, reserved: limit }]
      : inputs.map(input => typeof input === "string"
        ? this.entry(input.replace(/\\/g, "/").split("/").pop() || input, input)
        : this.entry(input.name, input, input.size));
    this.entries.push(...entries);
    this.picking = typeof selection === "string";
    const task = this.prepare(entries, selection, limit);
    this.publish();
    return task;
  }

  private async prepare(entries: Entry[], selection: ComposerUploadSelection, limit: number): Promise<void> {
    const controller = new AbortController();
    for (const entry of entries) entry.controller = controller;
    let sources: RemoteUploadSource[] = [];
    try {
      sources = typeof selection === "string" ? await pickUploadSources(selection, limit, controller.signal)
        : Array.isArray(selection) ? await stageBrowserUploadSources(selection, controller.signal)
          : await stageDesktopUploadSources([...new Set(selection.paths)], controller.signal);
      throwIfAborted(controller.signal);
      if (typeof selection === "string") {
        const placeholder = entries[0];
        entries = sources.map(source => ({ ...this.entry(source.name, undefined, source.size), controller }));
        this.entries = this.entries.filter(entry => entry !== placeholder);
        this.entries.push(...entries);
        this.picking = false;
        if (!sources.length) this.interruptions++;
      }
      sources.forEach((source, index) => { entries[index].source = source; entries[index].size = source.size; });
      this.publish();
    } catch (error) {
      await releaseUploadSources(sources);
      if (typeof selection === "string") this.picking = false;
      this.fail(entries, error);
      return;
    }
    for (const entry of entries) {
      if (entry.removed) { await this.release(entry); continue; }
      if (controller.signal.aborted) {
        this.fail([entry], new DOMException("cancelled", "AbortError"));
        continue;
      }
      await this.upload(entry);
    }
  }

  private fail(entries: Entry[], cause: unknown) {
    for (const entry of entries) {
      entry.state = "failed";
      entry.error = cause instanceof DOMException && cause.name === "AbortError"
        ? "上传已暂停，请重试或移除" : errorMessage(cause);
      entry.controller = undefined;
    }
    this.publish();
  }

  private async upload(entry: Entry): Promise<void> {
    if (entry.removed) { await this.release(entry); return; }
    const controller = new AbortController();
    entry.controller = controller;
    entry.state = "uploading";
    entry.progress = 0;
    entry.error = undefined;
    this.publish();
    try {
      const receipt = await uploadRemoteFile(this.client, this.scope, entry.source!, controller.signal, (sent, total) => {
        entry.progress = total ? Math.round(sent / total * 100) : 0;
        this.publish();
      });
      if (entry.removed) return;
      // A confirmed receipt belongs to the original draft even if pause raced the commit.
      this.onAttach([receipt.path]);
      this.entries = this.entries.filter(item => item !== entry);
      await this.release(entry);
    } catch (cause) {
      this.fail([entry], cause);
    } finally {
      entry.controller = undefined;
      if (entry.removed) await this.release(entry);
      this.publish();
    }
  }

  private async release(entry: Entry) {
    const source = entry.source;
    entry.source = undefined;
    if (source) await releaseUploadSources([source]);
  }

  retry(id: number, attachedCount: number) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry || entry.state !== "failed" || this.picking) return;
    entry.error = undefined;
    entry.state = "preparing";
    if (entry.source) void this.upload(entry);
    else if (entry.picker) {
      this.picking = true;
      entry.reserved = MAX_COMPOSER_ATTACHMENTS - attachedCount - this.entries.length + 1;
      void this.prepare([entry], entry.picker, entry.reserved);
    } else if (entry.input !== undefined) {
      void this.prepare([entry], typeof entry.input === "string" ? { paths: [entry.input] } : [entry.input], 1);
    }
    this.publish();
  }

  remove(id: number) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;
    this.interruptions++;
    entry.removed = true;
    this.entries = this.entries.filter(item => item !== entry);
    // Other files in a shared preparation keep their selected originals.
    if (!this.entries.some(item => item.controller === entry.controller)) entry.controller?.abort();
    if (!entry.controller) void this.release(entry);
    this.publish();
  }

  pause() {
    this.interruptions++;
    for (const entry of this.entries) entry.controller?.abort();
    this.publish();
  }

  /** Receipts are attached before publishing completion. Stop waiting on the
   * first failure or cancellation, keeping the text and every original intact. */
  wait(signal: AbortSignal): Promise<boolean> {
    const interruptions = this.interruptions;
    return new Promise(resolve => {
      const check = () => {
        const failed = signal.aborted || interruptions !== this.interruptions || this.entries.some(entry => entry.state === "failed");
        if (!failed && this.entries.length) return;
        this.listeners.delete(check);
        signal.removeEventListener("abort", check);
        resolve(!failed);
      };
      this.listeners.add(check);
      signal.addEventListener("abort", check, { once: true });
      check();
    });
  }
}

const drafts = new WeakMap<RpcClient, Map<string, ComposerUploads>>();
export function composerUploads(client: RpcClient, key: string, scope: RemoteUploadScope): ComposerUploads {
  let queues = drafts.get(client);
  if (!queues) { queues = new Map(); drafts.set(client, queues); }
  let queue = queues.get(key);
  if (!queue) { queue = new ComposerUploads(client, scope); queues.set(key, queue); }
  return queue;
}
