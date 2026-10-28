// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { readComposerValue } from "../composerField";
import { HeroPage } from "./HeroPage";
import { STARTER_PROMPTS } from "./StarterPrompts";

vi.mock("./SessionModelControls", () => ({
  SessionModelControls: () => <button type="button">选择会话模型</button>,
}));
vi.mock("./VoiceInput", () => ({ VoiceInput: () => null }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function fixture(withProject = true) {
  const workspace = { id: "project", name: "stock_news", path: "/stock_news" };
  return {
    client: { mode: "remote", call: vi.fn().mockResolvedValue({ skills: [] }) },
    catalog: {
      selectedWorkspace: withProject ? workspace : undefined,
      workspaces: [workspace],
    },
    connection: {
      providerConfigured: true,
      approvalMode: "auto",
      changeApprovalMode: vi.fn(),
    },
    navigation: { setPage: vi.fn(), openSettings: vi.fn() },
    sessionModel: {},
    actions: {
      selectProject: vi.fn(),
      startTask: vi.fn().mockResolvedValue(true),
    },
    setError: vi.fn(),
  } as unknown as MiniqAppController;
}

it("uses the selected project and keeps project/approval controls before the input", () => {
  const app = fixture();
  render(<HeroPage app={app} slashCommands={[]} />);
  expect(
    screen.getByRole("heading", { name: "要在 stock_news 中完成什么？" }),
  ).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "消息" });
  expect(document.activeElement).not.toBe(input);
  const project = screen.getByRole("button", { name: "stock_news" });
  const approval = screen.getByRole("button", { name: "帮我批准" });
  for (const control of [project, approval]) {
    expect(
      control.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  fireEvent.click(project);
  fireEvent.click(screen.getByRole("option", { name: /stock_news/ }));
  expect(app.actions.selectProject).toHaveBeenCalledWith("project");
  fireEvent.click(approval);
  expect(screen.getByRole("option", { name: /^请求批准/ }).textContent).toContain(
    "编辑外部文件和使用互联网时始终询问",
  );
  expect(screen.getByRole("option", { name: /^帮我批准/ }).textContent).toContain(
    "仅对检测到的风险操作请求批准",
  );
  expect(screen.getByRole("option", { name: /^完全访问/ }).textContent).toContain(
    "不受限制地访问互联网和你电脑上的任何文件",
  );
  fireEvent.click(screen.getByRole("option", { name: /^请求批准/ }));
  expect(app.connection.changeApprovalMode).toHaveBeenCalledWith("alwaysAsk");
});

it("keeps examples separate from working extension shortcuts", () => {
  const app = fixture();
  render(<HeroPage app={app} slashCommands={[]} />);
  const examples = screen.getByRole("region", {
    name: "先选一个示例，再编辑任务",
  });
  expect(within(examples).getAllByRole("button")).toHaveLength(4);
  const extensions = screen.getByRole("region", { name: "工作流与扩展能力" });
  fireEvent.click(within(extensions).getByRole("button", { name: /技能/ }));
  expect(app.navigation.setPage).toHaveBeenCalledWith("skills");
  fireEvent.click(within(extensions).getByRole("button", { name: /连接器/ }));
  expect(app.navigation.setPage).toHaveBeenCalledWith("mcp");
  expect(app.actions.startTask).not.toHaveBeenCalled();
});

it("lets a sample be edited and sends only after explicit submission", async () => {
  const app = fixture();
  render(<HeroPage app={app} slashCommands={[]} />);
  fireEvent.click(screen.getByRole("button", { name: /提取 PDF 要点/ }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "消息",
  });
  const prompt = STARTER_PROMPTS.find((item) => item.id === "pdf-notes")!.prompt;
  expect(readComposerValue(input.parentElement)).toBe(prompt);
  expect(document.activeElement).toBe(input);
  expect(app.actions.startTask).not.toHaveBeenCalled();
  const draft = `${prompt}重点关注市场风险`;
  fireEvent.change(input, { target: { value: draft } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await vi.waitFor(() =>
    expect(app.actions.startTask).toHaveBeenCalledExactlyOnceWith(draft, []),
  );
});

it("keeps draft examples usable while project selection blocks sending", () => {
  const app = fixture(false);
  render(
    <HeroPage app={app} slashCommands={[]} sendBlockedReason="请先选择项目" />,
  );
  expect(
    screen.getByRole("heading", { name: "今天想完成什么？" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "选择项目" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /分析一份表格/ }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toContain(
    "CSV 或 Excel",
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" })
      .disabled,
  ).toBe(true);
  expect(app.actions.startTask).not.toHaveBeenCalled();
});
