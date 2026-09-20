import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RpcClient } from "../rpc";
import { DEFAULT_PROVIDER_MODEL, SettingsPanel, ZAIWEN_API_BASE_URL, ZAIWEN_API_PORTAL_URL } from "./Settings";

describe("SettingsPanel", () => {
  it("offers the official Zaiwen commercial API as a miniQ provider", () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        client={{ mode: "local" } as RpcClient}
        theme="jade"
        onThemeChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("获取在问 API Key");
    expect(html).toContain("连接在问");
    expect(html).not.toContain("API 协议");
    expect(html).not.toContain("Relay URL");
    expect(html).not.toContain("Model");
    expect(html).toContain(`href="${ZAIWEN_API_PORTAL_URL}"`);
    expect(ZAIWEN_API_BASE_URL).toBe("https://oneapi.zaiwenai.com/v1");
    expect(DEFAULT_PROVIDER_MODEL).toBe("gpt-5.6-sol");
  });

  it("keeps privacy and support available after a mobile remote connection", () => {
    const html = renderToStaticMarkup(
      <SettingsPanel
        client={{ mode: "remote" } as RpcClient}
        theme="jade"
        onThemeChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('href="https://chat.zaiwenai.com/miniq/privacy"');
    expect(html).toContain('href="https://chat.zaiwenai.com/miniq/support"');
    expect(html).toContain("HTTPS 加密传输");
  });
});
