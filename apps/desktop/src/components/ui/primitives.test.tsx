// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ListRow,
  Menu,
  MenuItem,
  Popover,
  Skeleton,
  Spinner,
  Switch,
} from "./index";

afterEach(cleanup);

describe("Button", () => {
  it("defaults to type=button and applies variant classes", () => {
    const onClick = vi.fn();
    render(<Button variant="danger" size="sm" onClick={onClick}>删除</Button>);
    const button = screen.getByRole("button", { name: "删除" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toContain("ui-button--danger");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("Switch", () => {
  it("exposes role=switch and toggles by click and keyboard", () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onChange={setOn} label="启用服务" />;
    }
    render(<Harness />);
    const control = screen.getByRole("switch", { name: "启用服务" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(control, { key: " " });
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("ignores input when disabled", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="x" disabled />);
    fireEvent.keyDown(screen.getByRole("switch"), { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ListRow", () => {
  it("renders a selectable row", () => {
    const onSelect = vi.fn();
    render(<ListRow title="标题" subtitle="副标题" selected onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /标题/ }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(document.querySelector(".ui-list-row.selected")).toBeTruthy();
  });
});

function MenuHarness(props: { onPick: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} onClick={() => setOpen(true)}>更多</button>
      <Menu open={open} anchorRef={anchor} onClose={() => setOpen(false)} label="操作">
        <MenuItem onClick={props.onPick} shortcut="⌘R">重命名</MenuItem>
        <MenuItem danger>删除</MenuItem>
      </Menu>
    </>
  );
}

describe("Menu", () => {
  it("focuses the first item, supports arrow keys and closes on Escape", () => {
    render(<MenuHarness onPick={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    expect(items[0].querySelector("kbd")?.textContent).toBe("⌘R");
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "更多" }));
  });

  it("runs the item and closes on click", () => {
    const onPick = vi.fn();
    render(<MenuHarness onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /重命名/ }));
    expect(onPick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Popover", () => {
  it("closes on outside mousedown and Escape", () => {
    function Harness() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button ref={anchor}>锚点</button>
          <div data-testid="outside" />
          <Popover open={open} anchorRef={anchor} onClose={() => setOpen(false)} label="详情">
            <button data-autofocus>内部</button>
          </Popover>
          <button onClick={() => setOpen(true)}>重新打开</button>
        </>
      );
    }
    render(<Harness />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "内部" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "详情" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新打开" }));
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConfirmDialog", () => {
  it("is a modal alertdialog with cancel focused and Escape cancelling", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open title="删除项目？" description="无法撤销" tone="danger" confirmLabel="删除" onCancel={onCancel} onConfirm={onConfirm} />,
    );
    const dialog = screen.getByRole("alertdialog", { name: "删除项目？" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("feedback states", () => {
  it("EmptyState announces only when live", () => {
    const { rerender } = render(<EmptyState title="空" description="说明" />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<EmptyState title="空" live />);
    expect(screen.getByRole("status").textContent).toContain("空");
  });

  it("Spinner is decorative unless labelled; Skeleton renders lines", () => {
    const { container } = render(<><Spinner /><Spinner label="加载中" /><Skeleton lines={3} /></>);
    expect(screen.getByRole("status", { name: "加载中" })).toBeTruthy();
    expect(container.querySelector(".ui-spinner[aria-hidden='true']")).toBeTruthy();
    expect(container.querySelectorAll(".ui-skeleton").length).toBeGreaterThanOrEqual(3);
  });
});
