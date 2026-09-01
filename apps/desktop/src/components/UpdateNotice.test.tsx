import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppUpdaterState } from "../hooks/useAppUpdater";
import { UpdateNotice } from "./UpdateNotice";

const IDLE: AppUpdaterState = {
  phase: "idle",
  version: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

describe("UpdateNotice", () => {
  it("offers a manual update check in packaged desktop builds", () => {
    const html = renderToStaticMarkup(
      <UpdateNotice
        supported
        state={IDLE}
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("检查更新");
  });

  it("stays hidden outside packaged desktop builds", () => {
    const html = renderToStaticMarkup(
      <UpdateNotice
        supported={false}
        state={IDLE}
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("does not present a missing platform package as an update failure", () => {
    const html = renderToStaticMarkup(
      <UpdateNotice
        supported
        state={{ ...IDLE, phase: "unavailable" }}
        onCheck={() => undefined}
        onInstall={() => undefined}
      />,
    );

    expect(html).toContain("当前平台暂无更新");
    expect(html).not.toContain("更新失败");
  });
});
