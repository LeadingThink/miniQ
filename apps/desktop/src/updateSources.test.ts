import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  UPDATE_PRIMARY_ENDPOINT,
  UPDATE_PRIMARY_HOST,
  isUpdateSourceFailure,
  updateCheckFailureMessage,
} from "./updateSources";

const GITHUB_FAILURE =
  "error sending request for url (https://github.com/LeadingThink/miniQ-releases/releases/latest/download/latest.json)";

it("keeps the reported primary source aligned with the updater config", () => {
  const config = JSON.parse(
    readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  );
  expect(config.plugins.updater.endpoints[0]).toBe(UPDATE_PRIMARY_ENDPOINT);
});

it("recognizes feed reads that failed", () => {
  expect(isUpdateSourceFailure(GITHUB_FAILURE)).toBe(true);
  expect(
    isUpdateSourceFailure(
      "error decoding response body for url (https://oss.zaiwen.top/releases/miniq/latest.json)",
    ),
  ).toBe(true);
  expect(isUpdateSourceFailure("Could not fetch a valid release JSON from the remote")).toBe(true);
  expect(isUpdateSourceFailure("signature verification failed")).toBe(false);
});

it("reports the primary source instead of the GitHub mirror", () => {
  expect(updateCheckFailureMessage(GITHUB_FAILURE)).toBe(
    `无法连接更新主源 ${UPDATE_PRIMARY_HOST}，请检查网络后重试。`,
  );
});

it("passes failures unrelated to the feed through", () => {
  expect(updateCheckFailureMessage("更新包签名校验失败")).toBe("更新包签名校验失败");
});
