import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RpcClient } from "../rpc";
import { SettingsPanel, ZAIWEN_API_BASE_URL, ZAIWEN_API_PORTAL_URL } from "./Settings";

describe("SettingsPanel", () => {
  it("offers the official Zaiwen commercial API as a miniQ provider", () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        client={{} as RpcClient}
        theme="paper"
        onThemeChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("获取在问 API Key");
    expect(html).toContain(`href="${ZAIWEN_API_PORTAL_URL}"`);
    expect(ZAIWEN_API_BASE_URL).toBe("https://oneapi.zaiwenai.com/v1");
  });
});
