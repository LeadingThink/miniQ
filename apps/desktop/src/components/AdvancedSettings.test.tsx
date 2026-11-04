// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { AdvancedSettings } from "./AdvancedSettings";

afterEach(cleanup);

it("loads and saves the maximum active subagent preference", async () => {
  const call = vi.fn().mockImplementation((method: string) => Promise.resolve(
    method === "settings.get" ? { agentPreferences: { maxSubagents: 12 } } : {},
  ));
  const client = { call } as unknown as RpcClient;
  const onClose = vi.fn();
  render(<AdvancedSettings client={client} onClose={onClose} />);

  const input = await screen.findByRole<HTMLInputElement>("spinbutton", { name: /最多子 Agent 数量/ });
  await waitFor(() => expect(input.value).toBe("12"));
  expect(input.min).toBe("1");
  expect(input.max).toBe("32");

  fireEvent.change(input, { target: { value: "16" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith(
    "settings.update",
    { agentPreferences: { maxSubagents: 16 } },
  ));
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps the last valid value when the number is outside the supported range", async () => {
  const call = vi.fn().mockResolvedValue({ agentPreferences: { maxSubagents: 8 } });
  render(<AdvancedSettings client={{ call } as unknown as RpcClient} onClose={vi.fn()} />);
  const input = await screen.findByRole<HTMLInputElement>("spinbutton", { name: /最多子 Agent 数量/ });
  await waitFor(() => expect(input.disabled).toBe(false));

  fireEvent.change(input, { target: { value: "33" } });
  expect(input.value).toBe("8");
});