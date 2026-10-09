// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdaterState } from "../hooks/useAppUpdater";
import { UpdateNotice } from "./UpdateNotice";

const IDLE: AppUpdaterState = {
  phase: "idle",
  version: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

afterEach(cleanup);

describe("UpdateNotice", () => {
  it.each([
    "任务执行中，请等待任务完成后更新。",
    "还有排队消息，请等待任务完成后更新。",
    "signature invalid: 更新包签名校验失败",
  ])("renders the failure reason in the notice body: %s", (reason) => {
    const onCheck = vi.fn();
    const onInstall = vi.fn();
    render(<UpdateNotice supported state={{ ...IDLE, phase: "error", error: reason }}
      onCheck={onCheck} onInstall={onInstall} />);
    expect(screen.getByRole("status").textContent).toContain(reason);
    expect(screen.getByText(reason).closest("[title]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /更新失败，重试/ }));
    expect(onCheck).toHaveBeenCalledOnce();
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("reports a completed no-update check with the installed version", () => {
    const html = renderToStaticMarkup(<UpdateNotice supported
      state={{ ...IDLE, phase: "up-to-date", version: "0.1.36" }}
      onCheck={() => undefined} onInstall={() => undefined} />);
    expect(html).toContain("已是最新版本");
    expect(html).toContain("v0.1.36");
    expect(html).toContain('role="status"');
  });
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
