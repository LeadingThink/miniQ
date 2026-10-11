// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { CreateSkillDialog } from "./CreateSkillDialog";

afterEach(cleanup);
const content = "---\nname: weekly-report\ndescription: 汇总本周提交生成周报\n---\n\n## 步骤\n1. 读取 git log\n";
const ok = { valid: true, name: "weekly-report", existingSkill: false, checks: [{ id: "format", level: "ok", message: "格式与名称有效" }] };

it("generates a draft from a goal, re-validates edits and saves only valid content", async () => {
  const call = vi.fn(async (method: string, params?: { content?: string }) => {
    if (method === "skill.create") return { content, name: "weekly-report", description: "d", validation: ok };
    if (method === "skill.validate") return params?.content?.includes("sk-") ? { ...ok, valid: false, checks: [{ id: "secrets", level: "error", message: "疑似敏感内容" }] } : ok;
    if (method === "skill.save") return { name: "weekly-report" };
    throw new Error(method);
  });
  const onSaved = vi.fn();
  render(<CreateSkillDialog client={{ call } as unknown as RpcClient} onClose={() => {}} onSaved={onSaved} />);
  const generate = screen.getByRole("button", { name: "生成草稿" }) as HTMLButtonElement;
  expect(generate.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("这个技能要做什么？"), { target: { value: "每周五整理周报" } });
  fireEvent.click(generate);
  const editor = await screen.findByLabelText("技能内容（SKILL.md）");
  expect(call).toHaveBeenCalledWith("skill.create", { goal: "每周五整理周报" });
  fireEvent.change(editor, { target: { value: `${content}\napi_key=sk-abcdefghijklmnopqrst` } });
  await waitFor(() => expect((screen.getByRole("button", { name: "保存技能" }) as HTMLButtonElement).disabled).toBe(true));
  expect(screen.getByText("疑似敏感内容")).toBeTruthy();
  fireEvent.change(editor, { target: { value: content } });
  await waitFor(() => expect((screen.getByRole("button", { name: "保存技能" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "保存技能" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith("weekly-report"));
  expect(call).toHaveBeenCalledWith("skill.save", { content });
});

it("keeps the description and shows the error when generation fails", async () => {
  const call = vi.fn(async () => { throw new Error("模型服务不可用"); });
  render(<CreateSkillDialog client={{ call } as unknown as RpcClient} onClose={() => {}} onSaved={() => {}} />);
  fireEvent.change(screen.getByLabelText("这个技能要做什么？"), { target: { value: "检查依赖更新" } });
  fireEvent.click(screen.getByRole("button", { name: "生成草稿" }));
  expect((await screen.findByRole("alert")).textContent).toContain("模型服务不可用");
  expect((screen.getByLabelText("这个技能要做什么？") as HTMLTextAreaElement).value).toBe("检查依赖更新");
});
