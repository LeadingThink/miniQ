// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { useSessionModel } from "../hooks/useSessionModel";
import { DEFAULT_MODEL_SETTINGS } from "../modelSelection";
import { SessionModelControls } from "./SessionModelControls";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(call: ReturnType<typeof vi.fn>) {
  const client = { call } as unknown as RpcClient;
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS },
    effective: {
      model: "minimax-m3",
      apiProtocol: "chat_completions",
      reasoningEffort: null,
    },
    ready: true,
    pending: false,
    error: null,
    update: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;
  render(<SessionModelControls client={client} model={model} busy={false} />);
  return model;
}

it("states the provider default when a model exposes no reasoning levels", async () => {
  const model = setup(
    vi.fn((method: string) =>
      Promise.resolve(
        method === "model.list"
          ? { models: ["minimax-m3"] }
          : { reasoningEfforts: [] },
      ),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  const row = await screen.findByRole("option", { name: "minimax-m3" });
  fireEvent.mouseEnter(row);
  expect(await screen.findByRole("group", { name: "思考强度" })).toBeTruthy();
  expect(screen.getByText("该模型不支持调整")).toBeTruthy();
  expect(model.update).not.toHaveBeenCalled();
});

it("opens the effort menu for the hovered model and applies both together", async () => {
  const call = vi.fn((method: string) =>
    method === "model.list"
      ? Promise.resolve({ models: ["minimax-m3", "gpt-5.6-sol"] })
      : Promise.resolve({ reasoningEfforts: ["low", "high"] }),
  );
  const model = setup(call);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  await screen.findByRole("option", { name: "minimax-m3" });
  expect(screen.queryByRole("option", { name: "gpt-5.6-sol" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
  const target = await screen.findByRole("option", { name: "gpt-5.6-sol" });
  expect(screen.queryByRole("button", { name: "高" })).toBeNull();
  fireEvent.mouseEnter(target);
  const high = await screen.findByRole("button", { name: "高" });
  const submenu = screen.getByRole("group", { name: "思考强度" });
  expect(submenu.parentElement).toBe(document.body);
  fireEvent.mouseDown(high);
  expect(screen.getByRole("dialog", { name: "选择会话模型" })).toBeTruthy();
  fireEvent.click(high);
  await waitFor(() =>
    expect(model.update).toHaveBeenCalledExactlyOnceWith({
      ...DEFAULT_MODEL_SETTINGS,
      model: "gpt-5.6-sol",
      apiProtocol: "auto",
      reasoningEffort: "high",
    }),
  );
});

it("shows description failures and lets the hovered submenu retry", async () => {
  let fail = true;
  setup(
    vi.fn(async (method: string) => {
      if (method === "model.list") return { models: ["minimax-m3"] };
      if (fail) throw new Error("temporarily unavailable");
      return { reasoningEfforts: ["high"] };
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  fireEvent.mouseEnter(
    await screen.findByRole("option", { name: "minimax-m3" }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("读取档位…")).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  const high = await screen.findByRole("button", { name: "高" });
  fireEvent.keyDown(high, { key: "Escape" });
  expect(screen.queryByRole("group", { name: "思考强度" })).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "模型 ID" }),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("dismisses the portal when clicking outside and when filtering its model away", async () => {
  setup(
    vi.fn(async (method: string) =>
      method === "model.list"
        ? { models: ["minimax-m3"] }
        : { reasoningEfforts: ["high"] },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  const row = await screen.findByRole("option", { name: "minimax-m3" });
  fireEvent.mouseEnter(row);
  await screen.findByRole("button", { name: "高" });
  fireEvent.change(screen.getByRole("textbox", { name: "模型 ID" }), {
    target: { value: "other" },
  });
  expect(screen.queryByRole("group", { name: "思考强度" })).toBeNull();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("distinguishes loading from unavailable reasoning settings", async () => {
  setup(
    vi.fn((method: string) =>
      method === "model.list"
        ? Promise.resolve({ models: ["minimax-m3"] })
        : new Promise(() => {}),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  const row = await screen.findByRole("option", { name: "minimax-m3" });
  fireEvent.mouseEnter(row);
  expect(screen.getByText("读取档位…")).toBeTruthy();
});

it("fits the submenu using its rendered height and keeps it on the right near the viewport edge", async () => {
  setup(
    vi.fn(async (method: string) =>
      method === "model.list"
        ? { models: ["minimax-m3"] }
        : { reasoningEfforts: ["high", "ultra"] },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  const row = await screen.findByRole("option", { name: "minimax-m3" });
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
    top: window.innerHeight - 40,
    left: window.innerWidth - 220,
    right: window.innerWidth - 20,
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("model-picker-submenu") ? 320 : 0;
    },
  );
  fireEvent.mouseEnter(row);
  const submenu = await screen.findByRole("group", { name: "思考强度" });
  expect(submenu.style.top).toBe(`${window.innerHeight - 328}px`);
  expect(submenu.style.left).toBe(`${window.innerWidth - 172}px`);
  expect(await screen.findByRole("button", { name: "Ultra" })).toBeTruthy();
});
