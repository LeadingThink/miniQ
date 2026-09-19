import type { BrowserCapabilities } from "./types";

export interface EmbeddedBrowserAdapter {
  execute(operation: string, arguments_: Record<string, unknown>): Promise<Record<string, unknown>>;
  capabilities(): Promise<BrowserCapabilities>;
}

const adapters = new Map<string, EmbeddedBrowserAdapter>();
const waiters = new Map<string, Set<(adapter: EmbeddedBrowserAdapter) => void>>();

export function registerEmbeddedBrowser(
  browserSessionId: string,
  adapter: EmbeddedBrowserAdapter,
): () => void {
  adapters.set(browserSessionId, adapter);
  for (const resolve of waiters.get(browserSessionId) ?? []) resolve(adapter);
  waiters.delete(browserSessionId);
  return () => {
    if (adapters.get(browserSessionId) === adapter) adapters.delete(browserSessionId);
  };
}

function waitForBrowser(browserSessionId: string): Promise<EmbeddedBrowserAdapter> {
  const current = adapters.get(browserSessionId);
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const waiting = waiters.get(browserSessionId) ?? new Set();
    let timer = 0;
    const finish = (adapter: EmbeddedBrowserAdapter) => {
      window.clearTimeout(timer);
      resolve(adapter);
    };
    waiting.add(finish);
    waiters.set(browserSessionId, waiting);
    timer = window.setTimeout(() => {
      waiting.delete(finish);
      if (waiting.size === 0) waiters.delete(browserSessionId);
      reject(new Error("内嵌浏览器面板未能在 5 秒内就绪"));
    }, 5000);
  });
}

export async function executeEmbeddedBrowserRequest(
  viewId: string, operation: string, arguments_: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; capabilities: BrowserCapabilities }> {
  const adapter = await waitForBrowser(viewId);
  const [result, capabilities] = await Promise.all([
    adapter.execute(operation, arguments_),
    adapter.capabilities(),
  ]);
  return { result, capabilities };
}
