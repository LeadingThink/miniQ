// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { UNREAD_STORAGE_PREFIX, loadUnread, pruneUnread, saveUnread, withUnread } from "./unreadStore";

afterEach(() => window.localStorage.clear());

it("round-trips unread ids per host key and clears empty sets", () => {
  saveUnread("local", new Set(["a", "b"]));
  expect([...loadUnread("local")]).toEqual(["a", "b"]);
  expect(loadUnread("other").size).toBe(0);
  saveUnread("local", new Set());
  expect(window.localStorage.getItem(UNREAD_STORAGE_PREFIX + "local")).toBeNull();
});

it("ignores corrupt storage", () => {
  window.localStorage.setItem(UNREAD_STORAGE_PREFIX + "x", "{oops");
  expect(loadUnread("x").size).toBe(0);
  window.localStorage.setItem(UNREAD_STORAGE_PREFIX + "y", JSON.stringify(["a", 3]));
  expect([...loadUnread("y")]).toEqual(["a"]);
});

it("prunes missing sessions and keeps identity when unchanged", () => {
  const ids = new Set(["a", "b"]);
  expect(pruneUnread(ids, ["a", "b", "c"])).toBe(ids);
  expect([...pruneUnread(ids, ["a"])]).toEqual(["a"]);
  expect(pruneUnread(ids, [])).toBe(ids);
});

it("toggles unread and reports no-ops as null", () => {
  const ids = new Set(["a"]);
  expect(withUnread(ids, "a", true)).toBeNull();
  expect([...withUnread(ids, "b", true)!]).toEqual(["a", "b"]);
  expect([...withUnread(ids, "a", false)!]).toEqual([]);
});
