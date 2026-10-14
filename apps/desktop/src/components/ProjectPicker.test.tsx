// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectPicker } from "./ProjectPicker";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const workspaces = Array.from({ length: 12 }, (_, index) => ({
  id: `project-${index}`,
  name: `项目${index + 1}`,
  path: `D:/work/folder-${index + 1}`,
  additionalPaths: [],
  createdAt: "",
  updatedAt: "",
}));

function setup() {
  const onSelect = vi.fn(),
    onCreateBlank = vi.fn(),
    onOpenFolder = vi.fn();
  render(
    <div style={{ overflow: "hidden", backdropFilter: "blur(8px)" }}>
      <ProjectPicker
        workspaces={workspaces}
        selectedId="project-11"
        onSelect={onSelect}
        onCreateBlank={onCreateBlank}
        onOpenFolder={onOpenFolder}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "项目12" }));
  return { onSelect, onCreateBlank, onOpenFolder };
}

it("shows every project in a portal outside the clipping composer and selects beyond the eighth", () => {
  const { onSelect } = setup();
  const menu = screen.getByRole("dialog", { name: "选择项目" });
  expect(menu.parentElement).toBe(document.body);
  expect(menu.style.left).not.toBe("");
  expect(menu.style.top).not.toBe("");
  expect(screen.getAllByRole("option")).toHaveLength(12);
  const project = screen.getByRole("option", { name: /项目12/ });
  expect(project.getAttribute("aria-selected")).toBe("true");
  fireEvent.mouseDown(project);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(project);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("project-11");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("finds a folder by its path and selects it with the keyboard", () => {
  const { onSelect } = setup();
  const search = screen.getByPlaceholderText("搜索项目");
  fireEvent.change(search, { target: { value: "D:/work/folder-11" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("project-10");
});

it("closes on Escape or outside click, and preserves create/open folder actions", () => {
  const { onCreateBlank, onOpenFolder } = setup();
  fireEvent.keyDown(screen.getByPlaceholderText("搜索项目"), { key: "Escape" });
  const trigger = screen.getByRole("button", { name: "项目12" });
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "新建空白项目" }));
  fireEvent.change(screen.getByPlaceholderText("项目名称"), {
    target: { value: "新项目" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  expect(onCreateBlank).toHaveBeenCalledExactlyOnceWith("新项目");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "使用现有文件夹" }));
  expect(onOpenFolder).toHaveBeenCalledOnce();
});
