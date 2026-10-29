// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { MemorySettingsControls } from "./MemorySettingsControls";
afterEach(cleanup);

describe("memory consent", () => {
  it("defaults auto-save off and sends explicit consent independently of recall", async () => {
    const call = vi.fn((method, params) => Promise.resolve(method === "memory.settings" ? { recallEnabled: true, autoSave: false } : params));
    const client = { call, onStatus: () => () => {} } as unknown as RpcClient;
    render(<MemorySettingsControls client={client} />);
    const auto = screen.getByRole("checkbox", { name: "自动保存项目偏好和事实" });
    await waitFor(() => expect((auto as HTMLInputElement).disabled).toBe(false));
    expect((auto as HTMLInputElement).checked).toBe(false);
    fireEvent.click(auto);
    await waitFor(() => expect(call).toHaveBeenCalledWith("memory.configure", { recallEnabled: true, autoSave: true }, expect.anything()));
    await waitFor(() => expect((auto as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole("checkbox", { name: "在聊天中使用已保存的记忆" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("memory.configure", { recallEnabled: false, autoSave: true }, expect.anything()));
  });
  it("preserves the saved switch after a rejected update", async () => {
    const call = vi.fn((method) => method === "memory.settings" ? Promise.resolve({ recallEnabled: true, autoSave: false }) : Promise.reject(new Error("保存失败")));
    render(<MemorySettingsControls client={{ call, onStatus: () => () => {} } as unknown as RpcClient} />);
    const auto = screen.getByRole("checkbox", { name: "自动保存项目偏好和事实" });
    await waitFor(() => expect((auto as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(auto);
    await screen.findByText("保存失败");
    expect((auto as HTMLInputElement).checked).toBe(false);
  });
  it("does not apply a late response from a previous daemon", async () => {
    let finish!: (value: unknown) => void;
    const old = { call: vi.fn(() => new Promise((resolve) => { finish = resolve; })), onStatus: () => () => {} } as unknown as RpcClient;
    const view = render(<MemorySettingsControls client={old} />);
    const next = { call: vi.fn().mockResolvedValue({ recallEnabled: false, autoSave: false }), onStatus: () => () => {} } as unknown as RpcClient;
    view.rerender(<MemorySettingsControls client={next} />);
    await act(async () => finish({ recallEnabled: true, autoSave: true }));
    expect((screen.getByRole("checkbox", { name: "在聊天中使用已保存的记忆" }) as HTMLInputElement).checked).toBe(false);
  });
});
