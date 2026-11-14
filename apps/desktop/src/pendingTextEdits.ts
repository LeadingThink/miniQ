type SaveText = (path: string, content: string) => Promise<void>;

interface PendingTextEdit {
  content: string;
  revision: number;
  save: SaveText;
}

const pendingEdits = new Map<string, PendingTextEdit>();
let revision = 0;

export function registerPendingTextEdit(
  path: string,
  content: string,
  save: SaveText,
): void {
  pendingEdits.set(path, { content, save, revision: ++revision });
}

export function discardPendingTextEdit(path: string): void {
  pendingEdits.delete(path);
}

export async function flushPendingTextEdits(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    const pending = pendingEdits.get(path);
    if (!pending) return;
    await pending.save(path, pending.content);
    if (pendingEdits.get(path)?.revision === pending.revision)
      pendingEdits.delete(path);
  }));
}
