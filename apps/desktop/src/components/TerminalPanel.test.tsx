// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { TerminalPanel } from "./TerminalPanel";

const xterm = vi.hoisted(() => ({
  onData: null as null | ((data: string) => void),
  write: vi.fn(),
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  rows = 24;
  cols = 80;
  loadAddon() {}
  open() {}
  focus() {}
  dispose() {}
  write = xterm.write;
  onData(callback: (data: string) => void) { xterm.onData = callback; return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("forwards backspace and cursor keys unchanged and displays PTY erase sequences", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  let completeRead!: (value: unknown) => void;
  const call = vi.fn((method: string) => {
    if (method === "terminal.create") return Promise.resolve({ terminalId: "pty" });
    if (method === "terminal.read") return new Promise((resolve) => { completeRead = resolve; });
    return Promise.resolve({ ok: true });
  });
  const { unmount } = render(<TerminalPanel client={{ call } as unknown as RpcClient} sessionId="session" />);
  await waitFor(() => expect(call).toHaveBeenCalledWith("terminal.read", expect.anything(), expect.anything()));
  act(() => {
    xterm.onData!("abx");
    xterm.onData!("\x7f");
    xterm.onData!("c\x1b[Dz\r");
  });
  await waitFor(() => expect(call).toHaveBeenCalledWith("terminal.input", {
    sessionId: "session", terminalId: "pty", data: "abx\x7fc\x1b[Dz\r",
  }));
  const redraw = "abx\b \bc\x1b[Dzc\r\n<abzc>\r\n";
  await act(async () => completeRead({ status: "running", stdout: redraw, stdoutPage: { nextOffset: 40 } }));
  expect(xterm.write).toHaveBeenCalledExactlyOnceWith(redraw);
  expect(call).toHaveBeenCalledWith("terminal.read", expect.objectContaining({ offset: 40 }), expect.anything());
  unmount();
  expect(call).toHaveBeenCalledWith("terminal.close", { sessionId: "session", terminalId: "pty" });
});
