// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { useZaiwenChat } from "../hooks/useZaiwenChat";
import { useZaiwenModelControls } from "../hooks/useZaiwenModelControls";
import { SessionModelControls } from "./SessionModelControls";

const call = vi.fn();
const client = { call } as unknown as RpcClient;
const models = [{ key: "zaiwen-auto" }, { key: "deepseek-chat" }];
function Picker() {
  const [selected, setModel] = useState("zaiwen-auto");
  const { catalog, model } = useZaiwenModelControls({ models, model: selected, setModel, busy: false, modelError: "" } as ReturnType<typeof useZaiwenChat>);
  return <><output aria-label="当前模型">{selected}</output><SessionModelControls client={client} model={model} catalog={catalog} busy={false} /></>;
}
beforeEach(() => { call.mockClear(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])("uses the same model surface with cloud data (mobile=%s)", async (mobile) => {
  vi.stubGlobal("matchMedia", () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  render(<Picker />);
  const trigger = screen.getByRole("button", { name: "选择模型和思考强度" });
  fireEvent.click(trigger);
  await screen.findByRole("option", { name: "zaiwen-auto" });
  expect(screen.getByRole("dialog", { name: "选择会话模型" }).tagName).toBe(mobile ? "DIALOG" : "DIV");
  fireEvent.change(screen.getByRole("textbox", { name: "模型 ID" }), { target: { value: "deepseek" } });
  const option = screen.getByRole("option", { name: "deepseek-chat" });
  if (!mobile) {
    fireEvent.click(screen.getByRole("button", { name: "收藏 deepseek-chat" }));
    fireEvent.click(screen.getByRole("button", { name: "收藏" }));
    expect(screen.getByRole("option", { name: "deepseek-chat" })).toBe(option);
  }
  fireEvent.click(option);
  if (mobile) {
    expect(screen.getByLabelText("当前模型").textContent).toBe("zaiwen-auto");
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
  }
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(trigger.textContent).toContain("deepseek-chat");
  fireEvent.click(trigger);
  await screen.findByRole("option", { name: "deepseek-chat" });
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(trigger.textContent).toContain("zaiwen-auto");
  expect(call).not.toHaveBeenCalled();
});
