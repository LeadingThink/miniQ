import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("allows renderer-generated CSS in packaged apps without relaxing scripts", () => {
  const { app } = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  const { csp, dangerousDisableAssetCspModification } = app.security;
  // A style nonce overrides unsafe-inline, silently blocking Monaco, Mermaid
  // and Office styles created after startup. Exclude only this directive from
  // Tauri's nonce injection; script nonces and the script policy remain intact.
  expect(dangerousDisableAssetCspModification).toEqual(["style-src"]);
  const directives = new Map<string, string[]>(
    csp.split(";").map((part: string) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
  expect(directives.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  expect(directives.get("script-src")).toEqual([
    "'self'",
    "'wasm-unsafe-eval'",
  ]);
  expect(directives.get("worker-src")).toEqual(["'self'", "blob:"]);
});
