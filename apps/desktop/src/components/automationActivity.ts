import type { ToolCall } from "../types";

const AUTOMATION_TOOLS = new Set([
  "computer_use",
  "browser_automation",
  "app_automation",
]);

const ACTION_LABELS: Record<string, Record<string, [string, string]>> = {
  computer_use: {
    status: ["正在检查桌面控制", "检查了桌面控制"],
    screenshot: ["正在观察桌面", "观察了桌面"],
    click: ["正在点击桌面", "点击了桌面"],
    doubleClick: ["正在双击桌面", "双击了桌面"],
    move: ["正在移动指针", "移动了指针"],
    drag: ["正在拖拽桌面", "拖拽了桌面"],
    scroll: ["正在滚动桌面", "滚动了桌面"],
    type: ["正在输入文本", "输入了文本"],
    key: ["正在按键", "按下了按键"],
    wait: ["正在等待界面更新", "等待了界面更新"],
    release: ["正在释放桌面控制", "释放了桌面控制"],
  },
  browser_automation: {
    status: ["正在检查内置浏览器", "检查了内置浏览器"],
    open: ["正在打开网页", "打开了网页"],
    navigate: ["正在跳转网页", "跳转了网页"],
    newTab: ["正在新建网页标签", "新建了网页标签"],
    switchTab: ["正在切换网页标签", "切换了网页标签"],
    closeTab: ["正在关闭网页标签", "关闭了网页标签"],
    tabs: ["正在查看网页标签", "查看了网页标签"],
    snapshot: ["正在读取网页", "读取了网页"],
    screenshot: ["正在观察网页", "观察了网页"],
    click: ["正在点击网页", "点击了网页"],
    doubleClick: ["正在双击网页", "双击了网页"],
    move: ["正在移动网页指针", "移动了网页指针"],
    drag: ["正在拖拽网页", "拖拽了网页"],
    scroll: ["正在滚动网页", "滚动了网页"],
    type: ["正在填写网页", "填写了网页"],
    select: ["正在选择网页选项", "选择了网页选项"],
    press: ["正在按下网页按键", "按下了网页按键"],
    back: ["正在返回上一页", "返回了上一页"],
    forward: ["正在前往下一页", "前往了下一页"],
    reload: ["正在刷新网页", "刷新了网页"],
    wait: ["正在等待网页更新", "等待了网页更新"],
    close: ["正在关闭内置浏览器", "关闭了内置浏览器"],
  },
  app_automation: {
    status: ["正在检查应用控制", "检查了应用控制"],
    windows: ["正在查找应用窗口", "查看了应用窗口"],
    inspect: ["正在观察应用", "观察了应用"],
    screenshot: ["正在观察应用", "观察了应用"],
    invoke: ["正在后台操作应用", "后台应用操作"],
    select: ["正在选择应用内容", "选择了应用内容"],
    setValue: ["正在设置应用内容", "设置了应用内容"],
    key: ["正在向应用发送按键", "向应用发送了按键"],
    type: ["正在向应用输入文本", "向应用输入了文本"],
    click: ["正在点击应用", "点击了应用"],
    scroll: ["正在滚动应用", "滚动了应用"],
    release: ["正在释放应用控制", "释放了应用控制"],
  },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function point(x: unknown, y: unknown): string | null {
  const left = number(x);
  const top = number(y);
  return left === null || top === null ? null : `(${Math.round(left)}, ${Math.round(top)})`;
}

function pointerSummary(input: Record<string, unknown>): string | null {
  const start = point(input.x, input.y);
  if (!start) return null;
  if (input.action !== "drag") return start;
  const end = point(input.endX, input.endY);
  if (!end) return start;
  const startX = number(input.x)!;
  const startY = number(input.y)!;
  const endX = number(input.endX)!;
  const endY = number(input.endY)!;
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.round(Math.hypot(dx, dy));
  const direction = Math.abs(dy) >= Math.abs(dx)
    ? dy >= 0 ? "向下" : "向上"
    : dx >= 0 ? "向右" : "向左";
  return `${direction}拖动 ${distance} px · ${start} -> ${end}`;
}

function scrollSummary(input: Record<string, unknown>): string | null {
  const x = number(input.scrollX) ?? 0;
  const y = number(input.scrollY) ?? 0;
  const parts = [];
  if (y) parts.push(`${y > 0 ? "向下" : "向上"} ${Math.abs(y)} 格`);
  if (x) parts.push(`${x > 0 ? "向右" : "向左"} ${Math.abs(x)} 格`);
  return parts.length ? parts.join("、") : null;
}

function keySummary(input: Record<string, unknown>): string | null {
  if (typeof input.key !== "string") return null;
  const modifiers = Array.isArray(input.modifiers)
    ? input.modifiers.filter((value): value is string => typeof value === "string")
    : [];
  return [...modifiers, input.key].join(" + ");
}

function textLength(input: Record<string, unknown>): string | null {
  if (typeof input.text !== "string") return null;
  return `${Array.from(input.text).length} 个字符`;
}

function targetName(call: ToolCall): string | null {
  const target = record(record(call.output).target);
  const names = [target.appName, target.title].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return names.length ? names.join(" · ") : null;
}

export function isAutomationCall(call: ToolCall): boolean {
  return AUTOMATION_TOOLS.has(call.toolName);
}

export function automationActionLabel(
  toolName: string,
  input: unknown,
  running: boolean,
): string | null {
  const action = record(input).action;
  if (typeof action !== "string") return null;
  const labels = ACTION_LABELS[toolName]?.[action];
  return labels?.[running ? 0 : 1] ?? null;
}

export function automationInputSummary(call: ToolCall): string | null {
  if (!isAutomationCall(call)) return null;
  const input = record(call.input);
  const action = typeof input.action === "string" ? input.action : "";
  const parts: string[] = [];
  const target = targetName(call);
  if (target) parts.push(target);

  if (action === "drag") parts.push(pointerSummary(input) ?? "拖拽");
  else if (["click", "doubleClick", "move"].includes(action)) {
    const at = pointerSummary(input);
    if (at) parts.push(at);
  } else if (action === "scroll") {
    const direction = scrollSummary(input);
    if (direction) parts.push(direction);
  } else if (["type", "setValue"].includes(action)) {
    const length = textLength(input) ?? textLength(record(input.value));
    if (length) parts.push(length);
  } else if (["key", "press"].includes(action)) {
    const key = keySummary(input);
    if (key) parts.push(key);
  } else if (typeof input.url === "string") parts.push(input.url);
  else if (typeof input.target === "string") parts.push(input.target);
  else if (typeof input.elementId === "string") parts.push(`控件 ${input.elementId}`);
  else if (typeof input.windowId === "number") parts.push(`窗口 ${input.windowId}`);

  if (action === "wait" && typeof input.milliseconds === "number") {
    parts.push(`${input.milliseconds} ms`);
  }
  if (parts.length) return parts.join(" · ");
  const fallback = {
    screenshot: "获取当前画面",
    snapshot: "获取当前页面结构",
    status: "检查权限和状态",
    release: "释放控制权",
    tabs: "查看标签页",
    wait: "等待界面更新",
  }[action];
  return (fallback ?? action) || null;
}

export function automationGroupSummary(calls: ToolCall[]): string | null {
  const counts = { computer_use: 0, browser_automation: 0, app_automation: 0 };
  for (const call of calls) {
    if (call.toolName in counts) counts[call.toolName as keyof typeof counts] += 1;
  }
  const labels = [
    counts.computer_use ? `${counts.computer_use} 次桌面` : null,
    counts.browser_automation ? `${counts.browser_automation} 次网页` : null,
    counts.app_automation ? `${counts.app_automation} 次应用` : null,
  ].filter((value): value is string => value !== null);
  return labels.length ? labels.join(" · ") : null;
}

export function automationResultLabel(call: ToolCall): string | null {
  if (!isAutomationCall(call) || call.output === undefined || call.output === null) return null;
  const output = record(call.output);
  if (typeof output.observationId === "string") return "已取得操作后画面，可继续安全操作";
  if (output.released === true) return "控制已释放";
  if (call.status === "succeeded") return "操作结果已返回";
  return null;
}
