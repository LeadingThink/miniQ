// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { MobileModelPicker } from "./MobileModelPicker";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const catalog = () => ({
  models: ["gpt-test", "gemini-test", "claude-test"], model: "gpt-test",
  loading: false, error: null, selectModel: vi.fn(), reload: vi.fn(),
});
const openPicker = () => {
  const trigger = screen.getByRole("button", { name: "问答模型" });
  fireEvent.click(trigger);
  return trigger;
};

it("opens a modal outside the header stacking context and focuses its search", () => {
  const modal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
  const view = render(<header style={{ backdropFilter: "blur(24px)" }}><MobileModelPicker catalog={catalog()} disabled={false} /></header>);
  const trigger = openPicker();
  const dialog = screen.getByRole("dialog", { name: "选择问答模型" });
  expect(modal).toHaveBeenCalledOnce();
  expect(dialog.parentElement).toBe(document.body);
  expect(view.container.contains(dialog)).toBe(false);
  expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("searchbox"));
});

it("searches case-insensitively, selects the model, and restores focus after closing", () => {
  const models = catalog();
  render(<MobileModelPicker catalog={models} disabled={false} />);
  const trigger = openPicker();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: " GEMINI " } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.click(screen.getByRole("option", { name: "gemini-test" }));
  expect(models.selectModel).toHaveBeenCalledWith("gemini-test");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  openPicker();
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  expect(screen.getAllByRole("option")).toHaveLength(3);
});

it.each(["cancel", "button", "backdrop"])("dismisses via %s without changing the selected model", (method) => {
  const models = catalog();
  render(<MobileModelPicker catalog={models} disabled={false} />);
  const trigger = openPicker();
  const dialog = screen.getByRole("dialog");
  if (method === "cancel") fireEvent(dialog, new Event("cancel", { cancelable: true }));
  else if (method === "button") fireEvent.click(screen.getByRole("button", { name: "关闭模型选择" }));
  else fireEvent.click(dialog, { clientX: -1, clientY: -1 });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(models.selectModel).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});

it("does not dismiss a click within the dialog and supports model navigation from search", () => {
  render(<MobileModelPicker catalog={catalog()} disabled={false} />);
  openPicker();
  fireEvent.click(screen.getByRole("dialog"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "gpt-test" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "gemini-test" }));
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "claude-test" }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(screen.getByRole("option", { name: "gpt-test" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
  expect(screen.getByRole("status").textContent).toBe("没有匹配的文本模型");
});

it("removes the modal when model selection becomes unavailable", () => {
  const models = catalog();
  const view = render(<MobileModelPicker catalog={models} disabled={false} />);
  openPicker();
  view.rerender(<MobileModelPicker catalog={models} disabled />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect((screen.getByRole("button", { name: "问答模型" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<MobileModelPicker catalog={models} disabled={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});
