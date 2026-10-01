// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { DaemonEvent } from "../types";
import { SettingsLoadErrorBanner, type SettingsStatus } from "./SettingsLoadErrorBanner";

afterEach(cleanup);

const loadError = { path: "/data/settings.json", error: "EOF while parsing", backupPath: "/data/backups/settings.json.corrupt-1" };

function fixture(status: SettingsStatus, mode: "local" | "remote" = "local") {
  let emit: ((event: DaemonEvent) => void) | undefined;
  const call = vi.fn((method: string) =>
    Promise.resolve(method === "settings.restoreBackup" ? { backupAvailable: true } : status),
  );
  const client = {
    mode,
    call,
    onStatus: () => () => {},
    onEvent: (listener: (event: DaemonEvent) => void) => {
      emit = listener;
      return () => {};
    },
  } as unknown as RpcClient;
  return { client, call, emit: (event: unknown) => act(() => emit!(event as DaemonEvent)) };
}

it("shows the corrupt-settings banner from settings.status and restores the backup", async () => {
  const { client, call } = fixture({ loadError, backupAvailable: true });
  render(<SettingsLoadErrorBanner client={client} />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("配置文件损坏，已按默认配置启动，原文件未被覆盖");
  expect(alert.textContent).toContain("/data/settings.json");
  expect(call).toHaveBeenCalledWith("settings.status");
  fireEvent.click(screen.getByRole("button", { name: "恢复备份" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(call).toHaveBeenCalledWith("settings.restoreBackup");
});

it("appears on a settings_load_failed event and copies the path", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const { client, call, emit } = fixture({ backupAvailable: false });
  render(<SettingsLoadErrorBanner client={client} />);
  await waitFor(() => expect(call).toHaveBeenCalledWith("settings.status"));
  await act(async () => {
    await call.mock.results[0]!.value;
  });
  expect(screen.queryByRole("alert")).toBeNull();
  emit({ type: "settings_load_failed", ...loadError });
  expect(screen.getByRole("alert").textContent).toContain("EOF while parsing");
  expect(screen.queryByRole("button", { name: "恢复备份" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "复制文件路径" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("/data/settings.json"));
  expect(await screen.findByText(/已复制文件路径/)).toBeTruthy();
});

it("is read-only on remote clients", async () => {
  const { client } = fixture({ loadError, backupAvailable: true }, "remote");
  render(<SettingsLoadErrorBanner client={client} />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "恢复备份" })).toBeNull();
});
