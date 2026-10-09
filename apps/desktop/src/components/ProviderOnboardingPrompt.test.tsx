// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderOnboardingPrompt } from "./ProviderOnboardingPrompt";
import { getSendBlockedReason } from "./AppShell";
import type { MiniqAppController } from "../hooks/useMiniqApp";

afterEach(cleanup);

it("keeps setup recoverable after deferring without persisting dismissal", () => {
  const open = vi.fn();
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const view = render(<ProviderOnboardingPrompt onOpenSettings={open} />);
  fireEvent.click(screen.getByRole("button", { name: "稍后处理" }));
  fireEvent.click(screen.getByRole("button", { name: "配置模型服务" }));
  expect(open).toHaveBeenCalledOnce();
  expect(storage).not.toHaveBeenCalled();
  view.unmount();
  render(<ProviderOnboardingPrompt onOpenSettings={open} />);
  fireEvent.click(screen.getByRole("button", { name: "去设置" }));
  expect(open).toHaveBeenCalledTimes(2);
  storage.mockRestore();
});

it("distinguishes project, configuration, saving and loading for new and existing sessions", () => {
  const app = {
    catalog: { currentSessionId: null, selectedWorkspace: null },
    connection: { providerConfigured: false },
    sessionModel: { ready: false, pending: false, error: null },
  } as unknown as MiniqAppController;
  expect(getSendBlockedReason(app)).toBe("请先选择项目");
  app.catalog.currentSessionId = "existing";
  expect(getSendBlockedReason(app)).toContain("配置模型服务");
  app.connection.providerConfigured = true;
  expect(getSendBlockedReason(app)).toContain("正在加载");
  app.sessionModel.pending = true;
  expect(getSendBlockedReason(app)).toContain("正在保存");
  app.sessionModel.pending = false;
  app.sessionModel.error = "failed";
  expect(getSendBlockedReason(app)).toContain("加载失败");
  app.sessionModel.ready = true;
  expect(getSendBlockedReason(app)).toBeUndefined();
});
