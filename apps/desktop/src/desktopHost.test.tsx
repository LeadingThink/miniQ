// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DesktopHostProvider,
  hostDraftKey,
  useDesktopHost,
} from "./desktopHost";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function Workspace() {
  const target = useDesktopHost()!;
  const [text, setText] = useState("");
  return (
    <>
      <span data-testid="host">{target.host ?? "local"}</span>
      <input
        aria-label="draft"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button onClick={() => void target.selectHost("devbox")}>remote</button>
      <button onClick={() => void target.selectHost(null)}>local</button>
      <button onClick={() => void target.selectHost("local")}>
        alias named local
      </button>
      <span role="status">{target.pending ? "connecting" : "ready"}</span>
      {target.error && <span role="alert">{target.error}</span>}
    </>
  );
}

it("switches the entire workspace only after SSH succeeds and never forwards local settings", async () => {
  invoke.mockResolvedValue({ port: 2345, token: "fixture", host: "devbox" });
  render(
    <DesktopHostProvider>
      <Workspace />
    </DesktopHostProvider>,
  );
  fireEvent.change(screen.getByLabelText("draft"), {
    target: { value: "local private draft" },
  });
  fireEvent.click(screen.getByText("remote"));
  await waitFor(() =>
    expect(screen.getByTestId("host").textContent).toBe("devbox"),
  );
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("");
  expect(invoke).toHaveBeenCalledWith("ssh_connect", { host: "devbox" });
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("draft"), {
    target: { value: "remote draft" },
  });
  fireEvent.click(screen.getByText("local"));
  await waitFor(() =>
    expect(screen.getByTestId("host").textContent).toBe("local"),
  );
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("");
  expect(invoke).toHaveBeenLastCalledWith("ssh_disconnect");
  expect(hostDraftKey("devbox", "hero")).not.toBe(hostDraftKey(null, "hero"));
  expect(hostDraftKey("devbox", "same-session")).not.toBe(
    hostDraftKey("other", "same-session"),
  );
});

it("preserves the previous host and unsent input if SSH authentication fails", async () => {
  let reject!: (error: Error) => void;
  invoke.mockImplementation(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  render(
    <DesktopHostProvider>
      <Workspace />
    </DesktopHostProvider>,
  );
  fireEvent.change(screen.getByLabelText("draft"), {
    target: { value: "keep this" },
  });
  fireEvent.click(screen.getByText("remote"));
  fireEvent.click(screen.getByText("remote"));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toBe("connecting");
  reject(new Error("Host key verification failed"));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Host key verification failed",
  );
  expect(screen.getByTestId("host").textContent).toBe("local");
  expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(
    "keep this",
  );
});

it("isolates an SSH alias literally named local from this computer", async () => {
  invoke.mockResolvedValue({ port: 2345, token: "fixture", host: "local" });
  render(
    <DesktopHostProvider>
      <Workspace />
    </DesktopHostProvider>,
  );
  fireEvent.change(screen.getByLabelText("draft"), {
    target: { value: "private local state" },
  });
  fireEvent.click(screen.getByText("alias named local"));
  await waitFor(() =>
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe(""),
  );
  expect(invoke).toHaveBeenCalledWith("ssh_connect", { host: "local" });
});
