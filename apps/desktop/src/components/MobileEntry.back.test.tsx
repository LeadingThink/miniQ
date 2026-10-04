// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileAppearanceSheet } from "./MobileAppearanceSheet";
import { MobileEntry } from "./MobileEntry";

const native = vi.hoisted(() => ({ enabled: true, addListener: vi.fn(), minimizeApp: vi.fn() }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => native.enabled }));
vi.mock("@capacitor/app", () => ({ App: native }));
vi.mock("../remoteAccess", async (original) => ({
  ...await original<typeof import("../remoteAccess")>(),
  loadRemoteCredentials: async () => null,
}));
vi.mock("./MobileUpdateCheck", () => ({ MobileUpdateCheck: () => null }));
vi.mock("./MobileBackgroundLibrary", () => ({ MobileBackgroundLibrary: () => null }));

type Registration = { callback: () => void; remove: ReturnType<typeof vi.fn> };
let registrations: Registration[];
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  registrations = [];
  native.enabled = true;
  native.minimizeApp.mockReset().mockResolvedValue(undefined);
  native.addListener.mockReset().mockImplementation((_event: string, callback: () => void) => {
    // Keep removed callbacks deliverable to simulate a queued native event/removal race.
    const registration = { callback, remove: vi.fn().mockResolvedValue(undefined) };
    registrations.push(registration);
    return Promise.resolve(registration);
  });
});
afterEach(cleanup);

async function pressBack() {
  await act(async () => { [...registrations].forEach(({ callback }) => callback()); });
}

it.each([false, true])("closes appearance before the entry route or app (remote=%s)", async (remote) => {
  render(<MobileEntry onRemote={vi.fn()} />);
  await waitFor(() => expect(registrations).toHaveLength(1));
  if (remote) fireEvent.click(screen.getByRole("button", { name: /远程桌面/ }));
  fireEvent.click(screen.getByRole("button", { name: "外观" }));
  await waitFor(() => expect(registrations).toHaveLength(2));
  expect(registrations[0].remove).toHaveBeenCalledOnce();
  await pressBack();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(native.minimizeApp).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: remote ? "连接桌面 miniQ" : "随时继续工作" })).toBeTruthy();
  await waitFor(() => expect(registrations).toHaveLength(3));
  await pressBack();
  if (remote) {
    expect(screen.getByRole("heading", { name: "随时继续工作" })).toBeTruthy();
    expect(native.minimizeApp).not.toHaveBeenCalled();
    // Route changes update the callback without registering another listener.
    expect(registrations).toHaveLength(3);
    await pressBack();
  }
  expect(native.minimizeApp).toHaveBeenCalledOnce();
});

it("supports the connected workspace sheet without mounting MobileEntry", async () => {
  function Workspace() {
    const [open, setOpen] = useState(true);
    return open ? <MobileAppearanceSheet onClose={() => setOpen(false)} /> : <p>工作区</p>;
  }
  render(<Workspace />);
  await waitFor(() => expect(registrations).toHaveLength(1));
  await pressBack();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("工作区")).toBeTruthy();
  expect(registrations[0].remove).toHaveBeenCalledOnce();
  expect(native.minimizeApp).not.toHaveBeenCalled();
});

it("does not register if unmounted before the dynamic import settles", async () => {
  const view = render(<MobileAppearanceSheet onClose={vi.fn()} />);
  view.unmount();
  await act(async () => {});
  expect(native.addListener).not.toHaveBeenCalled();
});

it("removes a late registration and ignores its callback after unmount", async () => {
  let resolve!: (handle: { remove: () => Promise<void> }) => void;
  let callback!: () => void;
  native.addListener.mockImplementation((_event: string, listener: () => void) => {
    callback = listener;
    return new Promise((done) => { resolve = done; });
  });
  const onClose = vi.fn();
  const view = render(<MobileAppearanceSheet onClose={onClose} />);
  await waitFor(() => expect(native.addListener).toHaveBeenCalledOnce());
  view.unmount();
  const remove = vi.fn().mockResolvedValue(undefined);
  await act(async () => { callback(); resolve({ remove }); });
  expect(onClose).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
});

it("ignores retired callbacks even if native removal rejects", async () => {
  const onClose = vi.fn();
  const view = render(<MobileAppearanceSheet onClose={onClose} />);
  await waitFor(() => expect(registrations).toHaveLength(1));
  registrations[0].remove.mockRejectedValue(new Error("native removal failed"));
  view.unmount();
  await pressBack();
  expect(onClose).not.toHaveBeenCalled();
});

it("leaves web rendering free of native back listeners", async () => {
  native.enabled = false;
  render(<MobileEntry onRemote={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "外观" }));
  await act(async () => {});
  expect(native.addListener).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
