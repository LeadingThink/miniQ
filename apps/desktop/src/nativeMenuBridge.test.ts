// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { COMMAND_BUS_EVENT, MENU_COMMAND_IDS, dispatchMenuCommand, initializeNativeMenuBridge, isMenuCommandId } from "./nativeMenuBridge";

describe("nativeMenuBridge", () => {
  it("covers the command bus contract without duplicates", () => {
    expect(new Set(MENU_COMMAND_IDS).size).toBe(16);
    for (const id of ["newChat", "settings", "toggleSidebar", "palette", "find", "showShortcuts", "prevSession", "nextSession", "nextAttention", "archiveSession", "togglePin", "markUnread", "markAllRead", "back", "forward", "copyMarkdown"]) {
      expect(isMenuCommandId(id)).toBe(true);
    }
  });

  it("dispatches only known ids", () => {
    const seen: unknown[] = [];
    const handler = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(COMMAND_BUS_EVENT, handler);
    expect(dispatchMenuCommand("palette")).toBe(true);
    expect(dispatchMenuCommand("rm -rf")).toBe(false);
    expect(dispatchMenuCommand(42)).toBe(false);
    window.removeEventListener(COMMAND_BUS_EVENT, handler);
    expect(seen).toEqual([{ id: "palette" }]);
  });

  it("forwards native menu events and unlistens on dispose", async () => {
    let emit: ((event: { payload: unknown }) => void) | undefined;
    const off = vi.fn();
    const listen = vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => { emit = handler; return off; });
    const seen: unknown[] = [];
    const handler = (event: Event) => seen.push((event as CustomEvent).detail.id);
    window.addEventListener(COMMAND_BUS_EVENT, handler);
    const dispose = initializeNativeMenuBridge(listen);
    await vi.waitFor(() => expect(emit).toBeDefined());
    expect(listen.mock.calls[0][0]).toBe("menu-command");
    emit!({ payload: "nextSession" });
    emit!({ payload: "unknown" });
    await Promise.resolve();
    dispose();
    window.removeEventListener(COMMAND_BUS_EVENT, handler);
    expect(seen).toEqual(["nextSession"]);
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("drops a late subscription after dispose", async () => {
    const off = vi.fn();
    let resolve!: (value: () => void) => void;
    const listen = vi.fn(() => new Promise<() => void>((done) => { resolve = done; }));
    const dispose = initializeNativeMenuBridge(listen);
    dispose();
    await vi.waitFor(() => expect(listen).toHaveBeenCalled());
    resolve(off);
    await vi.waitFor(() => expect(off).toHaveBeenCalledTimes(1));
  });

  it("is a no-op outside Tauri", () => {
    expect(() => initializeNativeMenuBridge()()).not.toThrow();
  });
});
