// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComposerSlashCommand } from "../composerSlash";
import type { RpcClient } from "../rpc";
import { Composer, ComposerCard } from "./Composer";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const skills = [
  { name: "简历筛选", description: "并行筛选多份简历", enabled: true },
  { name: "禁用技能", description: "不应显示", enabled: false },
];
function commands(): ComposerSlashCommand[] {
  return [
    {
      id: "new",
      name: "新建会话",
      description: "开始新的工作",
      group: "会话",
      onSelect: vi.fn(),
    },
    {
      id: "review",
      name: "检查改动",
      description: "检查工作区文件差异",
      group: "工作流",
      keywords: ["audit"],
      insertText: "请审查当前改动。",
    },
  ];
}
function renderComposer(
  options: {
    call?: ReturnType<typeof vi.fn>;
    slashCommands?: ComposerSlashCommand[];
    workspaceId?: string;
  } = {},
) {
  const call = options.call ?? vi.fn().mockResolvedValue({ skills });
  const onSend = vi.fn().mockResolvedValue(true);
  const props = {
    busy: false,
    placeholder: "消息",
    client: { call } as unknown as RpcClient,
    draftKey: "slash-test",
    workspaceId: options.workspaceId ?? "workspace-one",
    onSend,
    slashCommands: options.slashCommands ?? commands(),
  };
  const view = render(<ComposerCard {...props} />);
  return {
    call,
    onSend,
    input: screen.getByRole<HTMLTextAreaElement>("textbox"),
    view,
    props,
  };
}

it("shows app command groups and only enabled skills in the current workspace", async () => {
  const { call, input } = renderComposer();
  fireEvent.change(input, { target: { value: "/" } });
  expect(screen.getByText("新建会话")).toBeTruthy();
  expect(screen.getByText("工作流")).toBeTruthy();
  expect(await screen.findByText("简历筛选")).toBeTruthy();
  expect(screen.getByText("技能")).toBeTruthy();
  expect(screen.queryByText("禁用技能")).toBeNull();
  expect(call).toHaveBeenCalledWith("skill.list", {
    workspaceId: "workspace-one",
  });
});

it("preserves workspace scoping through the session composer wrapper", async () => {
  const call = vi.fn().mockResolvedValue({ skills });
  render(
    <Composer
      busy={false}
      workspaceId="session-workspace"
      client={{ call } as unknown as RpcClient}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      slashCommands={commands()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
  await screen.findByText("简历筛选");
  expect(call).toHaveBeenCalledWith("skill.list", {
    workspaceId: "session-workspace",
  });
});

it("reopens the menu when a dismissed slash is deleted and typed again", async () => {
  const { input } = renderComposer();
  fireEvent.change(input, { target: { value: "/" } });
  await screen.findByRole("listbox");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.change(input, { target: { value: "/" } });
  expect(await screen.findByRole("listbox")).toBeTruthy();
});

it("does not overwrite a new file question when a pending command fails", async () => {
  let reject!: (error: Error) => void;
  const action = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const { input, view, props } = renderComposer({
    slashCommands: [
      {
        id: "change",
        name: "切换",
        description: "保存",
        group: "会话",
        onSelect: action,
      },
    ],
  });
  const onError = vi.fn();
  fireEvent.change(input, { target: { value: "/change" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(action).toHaveBeenCalledTimes(1);
  view.rerender(
    <ComposerCard
      {...props}
      onError={onError}
      draftRequest={{ id: 1, content: "关于文件 report.pdf：" }}
    />,
  );
  await act(async () => reject(new Error("save failed")));
  expect(input.value).toBe("关于文件 report.pdf：");
});

it("keeps more than thirty skills reachable, including by keyboard and search", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    name: `技能 ${i + 1}`,
    description: `处理项目编号 ${i + 1}`,
    enabled: true,
  }));
  const { input, onSend } = renderComposer({
    call: vi.fn().mockResolvedValue({ skills: many }),
    slashCommands: [],
  });
  fireEvent.change(input, { target: { value: "/" } });
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(40));
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(screen.getByRole("option", { selected: true }).textContent).toContain(
    "技能 40",
  );
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
    block: "nearest",
  });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input.value).toBe("使用技能「技能 40」：");
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => {});
  fireEvent.change(input, { target: { value: "/编号 40" } });
  expect(await screen.findByRole("option", { name: /技能 40/ })).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(1);
});

it("filters descriptions and aliases without sending the selected prompt", async () => {
  const { input, onSend } = renderComposer();
  fireEvent.change(input, { target: { value: "/AUDIT" } });
  expect(await screen.findByRole("option", { name: /检查改动/ })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("请审查当前改动。");
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => {});
  fireEvent.change(input, { target: { value: "/并行" } });
  expect(await screen.findByRole("option", { name: /简历筛选/ })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("使用技能「简历筛选」：");
  expect(onSend).not.toHaveBeenCalled();
});

it("wraps arrows and closes with Escape without losing the draft", async () => {
  const { input } = renderComposer();
  fireEvent.change(input, { target: { value: "/" } });
  await screen.findByText("简历筛选");
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expect(screen.getByRole("option", { selected: true }).textContent).toContain(
    "简历筛选",
  );
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getByRole("option", { selected: true }).textContent).toContain(
    "新建会话",
  );
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).toContain("option-1");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(input.value).toBe("/");
  fireEvent.change(input, { target: { value: "/audit" } });
  expect(screen.getByRole("listbox")).toBeTruthy();
});

it.each([
  "网址 https://example.com",
  "https://example.com",
  "/Users/person/report.pdf",
  "/tmp/",
  "C:\\work\\report.md",
  "/review\n请检查这段文字",
  "整理 /review 的结果",
])(
  "does not treat URLs, paths or multiline content as a command: %s",
  async (value) => {
    const { input } = renderComposer();
    fireEvent.change(input, { target: { value } });
    expect(screen.queryByRole("listbox")).toBeNull();
  },
);

it.each([{ isComposing: true }, { keyCode: 229 }])(
  "does not select or send during IME composition: %j",
  async (composition) => {
    const items = commands();
    const { input, onSend } = renderComposer({ slashCommands: items });
    fireEvent.change(input, { target: { value: "/" } });
    await screen.findByText("简历筛选");
    fireEvent.keyDown(input, { key: "Enter", ...composition });
    expect(input.value).toBe("/");
    expect(items[0].onSelect).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  },
);

it("loads submenu options, highlights the current model and applies a selected option", async () => {
  let resolve!: (commands: ComposerSlashCommand[]) => void;
  const loadChildren = vi.fn(
    () =>
      new Promise<ComposerSlashCommand[]>((done) => {
        resolve = done;
      }),
  );
  const onSelect = vi.fn();
  const { input, onSend } = renderComposer({
    slashCommands: [
      {
        id: "model",
        name: "切换模型",
        description: "选择当前会话模型",
        group: "会话",
        loadChildren,
      },
    ],
  });
  fireEvent.change(input, { target: { value: "/model" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("/model ");
  expect(screen.getByRole("status").textContent).toContain("正在加载切换模型");
  await act(async () =>
    resolve([
      {
        id: "model:a",
        name: "Model A",
        description: "快速",
        group: "模型",
        onSelect: vi.fn(),
      },
      {
        id: "model:b",
        name: "Model B",
        description: "已启用",
        group: "模型",
        selected: true,
        onSelect,
      },
    ]),
  );
  expect(loadChildren).toHaveBeenCalledOnce();
  expect(screen.getByRole("option", { selected: true }).textContent).toContain(
    "Model B",
  );
  expect(
    within(screen.getByRole("option", { selected: true })).getByLabelText(
      "当前设置",
    ),
  ).toBeTruthy();
  fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
  expect(onSend).not.toHaveBeenCalled();
  expect(input.value).toBe("");
});

it("retries failed submenu loads and returns to all commands with Escape", async () => {
  const loadChildren = vi
    .fn()
    .mockRejectedValueOnce(new Error("服务暂不可用"))
    .mockResolvedValueOnce([
      {
        id: "model:a",
        name: "Model A",
        description: "已恢复",
        group: "模型",
        onSelect: vi.fn(),
      },
    ]);
  const { input } = renderComposer({
    slashCommands: [
      {
        id: "model",
        name: "切换模型",
        description: "选择模型",
        group: "会话",
        loadChildren,
      },
    ],
  });
  fireEvent.change(input, { target: { value: "/model " } });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("服务暂不可用"),
  );
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("option", { name: /Model A/ })).toBeTruthy();
  expect(loadChildren).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("/");
  expect(screen.getByRole("option", { name: /切换模型/ })).toBeTruthy();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("does not run disabled actions or send unmatched slash queries", async () => {
  const onSelect = vi.fn();
  const { input, onSend } = renderComposer({
    slashCommands: [
      {
        id: "archive",
        name: "归档",
        description: "归档会话",
        group: "会话",
        disabled: true,
        disabledReason: "任务执行中",
        onSelect,
      },
    ],
  });
  fireEvent.change(input, { target: { value: "/archive" } });
  const item = screen.getByRole("option", { name: /归档/ });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.textContent).toContain("任务执行中");
  fireEvent.click(item);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSelect).not.toHaveBeenCalled();
  expect(input.value).toBe("/archive");
  fireEvent.change(input, { target: { value: "/nothing-matches" } });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("没有匹配"),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
});

it("ignores a skill response from a previous workspace", async () => {
  let resolveOld!: (result: { skills: typeof skills }) => void;
  const call = vi.fn().mockImplementation((_method, params) =>
    params.workspaceId === "workspace-one"
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve({
          skills: [
            { name: "新项目技能", description: "项目二", enabled: true },
          ],
        }),
  );
  const { input, props, view } = renderComposer({ call });
  fireEvent.change(input, { target: { value: "/" } });
  view.rerender(<ComposerCard {...props} workspaceId="workspace-two" />);
  expect(await screen.findByText("新项目技能")).toBeTruthy();
  expect(call).toHaveBeenLastCalledWith("skill.list", {
    workspaceId: "workspace-two",
  });
  await act(async () => resolveOld({ skills }));
  expect(screen.queryByText("简历筛选")).toBeNull();
  expect(screen.getByText("新项目技能")).toBeTruthy();
});

it("retries a failed skill listing while keeping local app commands available", async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({
      transcribe: false,
      speak: false,
      transcribeModel: null,
      ttsModel: null,
    })
    .mockRejectedValueOnce(new Error("技能读取失败"))
    .mockResolvedValueOnce({ skills });
  const { input } = renderComposer({ call });
  fireEvent.change(input, { target: { value: "/" } });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("技能读取失败"),
  );
  expect(screen.getByRole("option", { name: /新建会话/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("简历筛选")).toBeTruthy();
  expect(call.mock.calls.filter(([method]) => method === "skill.list")).toHaveLength(2);
});
