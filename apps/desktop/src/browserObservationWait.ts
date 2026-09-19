import type { BrowserScriptResult } from "./browserAutomationScript";

export interface BrowserNavigationExpectation {
  url?: string;
  previous?: Pick<BrowserScriptResult, "url"> & Partial<Pick<BrowserScriptResult, "documentId">>;
  previousUnavailable?: boolean;
}

function navigationCommitted(result: BrowserScriptResult, navigation?: BrowserNavigationExpectation) {
  if (!/^https?:\/\//i.test(result.url)) return false;
  if (!navigation?.previous) return true;
  const previous = navigation.previous;
  // A native navigate() acknowledges dispatch, not a document commit. The old
  // page can remain fully loaded while the destination is still connecting.
  return (Boolean(previous.documentId) && result.documentId !== previous.documentId) ||
    (result.url !== previous.url && (!previous.documentId || !navigation.url || result.url === navigation.url));
}

function signature(result: BrowserScriptResult) {
  return JSON.stringify({
    documentId: result.documentId,
    url: result.url,
    title: result.title,
    readyState: result.readyState,
    viewport: result.viewport,
    items: result.items,
    textLines: result.textLines,
    total: result.total,
    totalTextLines: result.totalTextLines,
  });
}

/** Wait for committed content; never report a stable old/blank document as a new page. */
export async function waitForBrowserObservation(
  observe: () => Promise<BrowserScriptResult>,
  navigation?: BrowserNavigationExpectation,
): Promise<BrowserScriptResult> {
  if (navigation?.previousUnavailable) {
    throw new Error("导航已发出，但旧页面状态暂时不可读取；请等待网页加载后重新获取页面观察");
  }
  const deadline = Date.now() + (navigation ? 30_000 : 1_800);
  let settledDeadline = deadline;
  let latest: BrowserScriptResult | undefined;
  let previousSignature: string | undefined;
  let stableSamples = 0;
  let lastError: unknown;
  await new Promise((resolve) => window.setTimeout(resolve, 80));
  while (Date.now() < Math.min(deadline, settledDeadline)) {
    try {
      const candidate = await observe();
      if (candidate.readyState === "loading" || !navigationCommitted(candidate, navigation)) {
        latest = undefined;
        previousSignature = undefined;
        stableSamples = 0;
        settledDeadline = deadline;
      } else {
        if (!latest) settledDeadline = Math.min(deadline, Date.now() + 1_800);
        latest = candidate;
        const nextSignature = signature(candidate);
        stableSamples = nextSignature === previousSignature ? stableSamples + 1 : 1;
        previousSignature = nextSignature;
        if (stableSamples >= 3) return candidate;
      }
    } catch (cause) {
      // Retrying an observation is safe; never replay the preceding mutation.
      lastError = cause;
      latest = undefined;
      previousSignature = undefined;
      stableSamples = 0;
      settledDeadline = deadline;
    }
    const remaining = Math.min(deadline, settledDeadline) - Date.now();
    if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, Math.min(120, remaining)));
  }
  // Continuously updating pages need not become network/DOM-idle, but they
  // must have committed and reached at least DOM interactive readiness.
  if (latest) return latest;
  if (navigation) throw new Error("网页仍未完成导航，请稍后重新获取页面；未将旧页面或空白页当成导航结果");
  if (lastError) throw lastError;
  throw new Error("浏览器动作后未能获取已就绪的页面观察");
}
