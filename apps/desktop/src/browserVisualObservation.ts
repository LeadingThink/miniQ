import type { BrowserScriptResult } from "./browserAutomationScript";
import { screenshotBrowser } from "./browserWorkbench";

function observationState(result: BrowserScriptResult): string {
  return JSON.stringify({
    documentId: result.documentId,
    url: result.url,
    tabId: result.tabId,
    viewport: result.viewport,
    items: result.items,
    textLines: result.textLines,
  });
}

/** Bind native pixels to a fresh DOM observation, without replaying an action. */
export async function captureBrowserObservation(
  viewId: string,
  observe: () => Promise<BrowserScriptResult>,
): Promise<BrowserScriptResult> {
  const before = await observe();
  const screenshotBase64 = await screenshotBrowser(viewId);
  const after = await observe();
  if (before.readyState === "loading" || after.readyState === "loading" ||
      observationState(before) !== observationState(after)) {
    throw new Error("截图期间网页发生变化，请重新获取页面观察后继续操作");
  }
  return { ...after, screenshotBase64 };
}
