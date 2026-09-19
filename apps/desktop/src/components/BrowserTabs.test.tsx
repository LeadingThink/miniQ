// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserTabs } from "./BrowserTabs";
import type { BrowserTab } from "../browserTabs";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Fixture() {
  const [tabs, setTabs] = useState<BrowserTab[]>(["a", "b", "c"].map((id) => ({
    id, viewId: `view-${id}`, url: `https://${id}.example.com`,
  })));
  const [activeId, setActiveId] = useState("a");
  return <BrowserTabs tabs={tabs} activeId={activeId} onSelect={setActiveId} onNew={() => {}} onClose={(id) => {
    const remaining = tabs.filter((tab) => tab.id !== id);
    setTabs(remaining);
    if (activeId === id) setActiveId(remaining[0]?.id ?? "");
  }} />;
}

it("keeps the selected browser tab reachable and supports keyboard switching", () => {
  const scroll = vi.fn();
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  try {
    render(<Fixture />);
    const first = screen.getByRole("tab", { name: "a.example.com" });
    expect(first.tabIndex).toBe(0);
    fireEvent.keyDown(first, { key: "End" });
    const last = screen.getByRole("tab", { name: "c.example.com" });
    expect(last.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(last);
    expect(scroll.mock.instances.at(-1)).toBe(last.parentElement);
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Delete" });
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "b.example.com" }));
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

it("keeps a focus destination when the last visible tab is closed", () => {
  render(<Fixture />);
  for (const id of ["a", "b", "c"]) {
    fireEvent.click(screen.getByRole("button", { name: `关闭网页标签 ${id}.example.com` }));
  }
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "新建网页标签" }));
});
