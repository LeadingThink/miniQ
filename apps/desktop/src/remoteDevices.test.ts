// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { clearSelectedDesktop, desktopsWithSelection, loadSelectedDesktop, rememberSelectedDesktop } from "./remoteDevices";

beforeEach(() => localStorage.clear());

it("remembers an explicit choice per identity without persisting live presence", () => {
  rememberSelectedDesktop("room-a", { id: "desktop-a", name: "电脑 A", online: true });
  expect(loadSelectedDesktop("room-a")).toEqual({ id: "desktop-a", name: "电脑 A", online: false });
  expect(loadSelectedDesktop("room-b")).toBeNull();
  clearSelectedDesktop("room-a");
  expect(loadSelectedDesktop("room-a")).toBeNull();
});

it("keeps the selected offline computer when only another computer is discovered", () => {
  const selected = { id: "a", name: "A", online: true };
  const online = { id: "b", name: "B", online: true };
  expect(desktopsWithSelection([online], selected)).toEqual([online, { ...selected, online: false }]);
  expect(desktopsWithSelection([online, online], online)).toEqual([online]);
});

it("ignores malformed saved selections", () => {
  localStorage.setItem("miniq.remote.desktop.v1:room", '{"id":1,"name":"A"}');
  expect(loadSelectedDesktop("room")).toBeNull();
});
