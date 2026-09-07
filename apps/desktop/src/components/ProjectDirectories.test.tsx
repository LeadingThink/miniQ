// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectDirectories } from "./ProjectDirectories";
import type { Session, Workspace } from "../types";

const workspace: Workspace = { id: "project", name: "Project", path: "/work/app", additionalPaths: ["/work/docs"], createdAt: "now", updatedAt: "now" };
const session: Session = { id: "old", workspaceId: "project", workingDirectory: "/work/app", title: "old", status: "idle", pinned: false, archived: false, createdAt: "now", updatedAt: "now" };

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("adds folders, changes primary, and preserves existing session directories", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  render(<ProjectDirectories workspace={workspace} sessions={[session]} onSave={save} onClose={close} />);
  fireEvent.change(screen.getByLabelText("目录绝对路径"), { target: { value: "/work/shared" } });
  fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
  fireEvent.click(screen.getByRole("button", { name: "设为主目录 /work/docs" }));
  expect((screen.getByRole("button", { name: "移除目录 /work/app" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(["/work/docs", "/work/app", "/work/shared"]));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("retains the edited paths after a rejected save", async () => {
  const save = vi.fn().mockRejectedValue(new Error("project has active child agents"));
  const close = vi.fn();
  render(<ProjectDirectories workspace={workspace} sessions={[]} onSave={save} onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: "移除目录 /work/docs" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("active child agents"));
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByText("/work/docs")).toBeNull();
});

it("validates remote absolute paths and duplicate directories", () => {
  render(<ProjectDirectories workspace={workspace} sessions={[]} onSave={vi.fn()} onClose={vi.fn()} />);
  const input = screen.getByLabelText("目录绝对路径");
  fireEvent.change(input, { target: { value: "relative/folder" } });
  fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
  expect(screen.getByRole("alert").textContent).toContain("绝对路径");
  fireEvent.change(input, { target: { value: "/work/docs" } });
  fireEvent.click(screen.getByRole("button", { name: "添加目录" }));
  expect(screen.getByRole("alert").textContent).toContain("已添加");
});

it("locks directory edits during an active task", () => {
  render(<ProjectDirectories workspace={workspace} sessions={[{ ...session, status: "running" }]} onSave={vi.fn()} onClose={vi.fn()} />);
  expect((screen.getByLabelText("目录绝对路径") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "设为主目录 /work/docs" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("任务正在运行");
});

it("remote viewing cannot expand desktop filesystem access", () => {
  render(<ProjectDirectories workspace={workspace} sessions={[]} onSave={vi.fn()} onClose={vi.fn()} readOnly />);
  expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  expect(screen.queryByLabelText("目录绝对路径")).toBeNull();
  expect((screen.getByRole("button", { name: "设为主目录 /work/docs" }) as HTMLButtonElement).disabled).toBe(true);
});
