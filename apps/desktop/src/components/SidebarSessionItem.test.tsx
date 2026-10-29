// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarSessionItem } from "./SidebarSessionItem";
const session = {id:"s", workspaceId:"w", workingDirectory:"/project", title:"完整会话标题", status:"idle" as const, pinned:false, archived:false, createdAt:"2026-09-01", updatedAt:"2026-09-01",preview:"最新回复的内容"};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.classList.remove("native-mobile");
});
it("keeps replies out of the row and exposes them through the actions menu", () => {
  const select = vi.fn();
  const {container} = render(<SidebarSessionItem session={session} current={false} unread={false} onSeen={vi.fn()} onSelect={select} onDelete={vi.fn()} onRename={vi.fn()} onSetPinned={vi.fn()} onSetArchived={vi.fn()}/>);
  expect(container.querySelector('.session-select')?.textContent).not.toContain(session.preview);
  fireEvent.click(screen.getByRole('button', {name:'完整会话标题'}));
  expect(select).toHaveBeenCalledWith('s');
  fireEvent.click(screen.getByRole('button', {name:'完整会话标题 的更多操作'}));
  expect(screen.getByText(session.preview)).toBeTruthy();
  expect(screen.getByText(session.preview).closest("[role=menuitem]")).toBeNull();
  expect(screen.getByRole('menuitem', {name:/重命名/})).toBeTruthy();
});

it.each([false, true])("shows elapsed time with 前 in %s native mobile webviews", (nativeMobile) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
  document.documentElement.classList.toggle("native-mobile", nativeMobile);
  const { container } = render(
    <SidebarSessionItem session={session} current={false} unread={false} onSeen={vi.fn()} onSelect={vi.fn()} onDelete={vi.fn()} onRename={vi.fn()} onSetPinned={vi.fn()} onSetArchived={vi.fn()} />,
  );
  expect(container.querySelector(".session-age")?.textContent).toBe("1天前");
});
