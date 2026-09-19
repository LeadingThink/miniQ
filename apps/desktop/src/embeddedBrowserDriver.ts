import type { RpcClient } from "./rpc";
import type { BrowserCapabilities, BrowserDriverRequest } from "./types";

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

export async function resolveBrowserDriverRequest(
  client: RpcClient,
  request: BrowserDriverRequest,
): Promise<Record<string, unknown> | undefined> {
  try {
    const adapter = await waitForBrowser(request.browserSessionId);
    const [result, capabilities] = await Promise.all([
      adapter.execute(request.operation, request.arguments),
      adapter.capabilities(),
    ]);
    await client.call("browser.resolve", {
      requestId: request.id,
      result: { capabilities, result },
    });
    return result;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    await client.call("browser.resolve", { requestId: request.id, error }).catch(() => {});
  }
}
