import { existsSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { BACKGROUNDS, getBackground, isBackgroundId } from "./backgroundCatalog";

it("ships complete local media without orphaned wallpaper assets", () => {
  const root = new URL("../public/backgrounds/", import.meta.url);
  const referenced = new Set<string>();
  for (const item of BACKGROUNDS) {
    if (item.kind === "video") {
      expect(item.video).toBeTruthy();
      expect(item.poster).toBeTruthy();
      expect(item.thumb).toBeTruthy();
    }
    for (const url of [item.video, item.poster, item.thumb]) {
      if (!url || /^https?:/.test(url)) continue;
      const name = url.slice(url.lastIndexOf("/") + 1);
      expect(existsSync(new URL(name, root)), `${item.id}: ${url}`).toBe(true);
      referenced.add(name);
    }
  }
  expect(readdirSync(root).sort()).toEqual([...referenced].sort());
});

it("offers distinct subjects, light and dark scenes, and unique identifiers", () => {
  expect(new Set(BACKGROUNDS.map(item => item.id)).size).toBe(BACKGROUNDS.length);
  expect(new Set(BACKGROUNDS.map(item => item.name)).size).toBe(BACKGROUNDS.length);
  const added = BACKGROUNDS.filter(item => item.bundled);
  expect(added).toHaveLength(9);
  expect(new Set(added.map(item => item.group))).toEqual(new Set([
    "人物风景", "动物伙伴", "原创动漫", "立体构成", "自然风景", "室内植物",
  ]));
  expect(added.some(item => item.light)).toBe(true);
  expect(added.some(item => !item.light)).toBe(true);
  for (const item of added) {
    expect(item.drift).toBe(false);
    expect(item.position).toMatch(/^\d+% \d+%$/);
    expect(item.video).not.toMatch(/^https?:/);
  }
});

it.each(["01-spacecat", "09-nightcar", "t016", "glyph-decode", "glyph-fabric", "ambient-rain-silver", "ambient-bokeh-neon"])(
  "does not restore removed background %s", id => {
    expect(isBackgroundId(id)).toBe(false);
    expect(getBackground(id).id).toBe("none");
  },
);
