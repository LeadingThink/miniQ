import { beforeEach, expect, it } from "vitest";
import { IosInstalledReleaseNotices } from "./iosInstalledReleaseNotice";
let data: Map<string, string>;
let notices: IosInstalledReleaseNotices;
beforeEach(() => {
  data = new Map();
  notices = new IosInstalledReleaseNotices({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } });
});
it("records first-install baseline silently and shows an upgrade only once", () => {
  expect(notices.pending("1.0")).toBeNull();
  expect(notices.pending("1.1")?.version).toBe("1.1");
  expect(notices.pending("1.1")).not.toBeNull();
  notices.markShown("1.1");
  expect(notices.pending("1.1")).toBeNull();
  expect(notices.pending("1.0")).toBeNull();
});
it("uses cached notes only for the installed version, never future App Store notes", () => {
  notices.pending("1.0");
  notices.cache({ platform: "ios", version: "1.1", releaseNotes: ["当前说明"] });
  notices.cache({ platform: "ios", version: "1.2", releaseNotes: ["未来说明"] });
  expect(notices.pending("1.1")?.releaseNotes).toEqual(["当前说明"]);
  expect(notices.pending("1.3")?.releaseNotes).toEqual([]);
});
it("normalizes equivalent version numbers and ignores Android notes", () => {
  notices.pending("1.0");
  expect(notices.pending("v1.0.0")).toBeNull();
  notices.cache({ platform: "android", version: "1.1", releaseNotes: ["APK说明"] });
  expect(notices.pending("1.1")?.releaseNotes).toEqual([]);
});
it("retains once-only behavior in memory when storage fails", () => {
  const broken = new IosInstalledReleaseNotices({ getItem: () => { throw Error(); }, setItem: () => { throw Error(); } });
  expect(broken.pending("1.0")).toBeNull();
  expect(broken.pending("1.1")).not.toBeNull();
  broken.markShown("1.1");
  expect(broken.pending("1.1")).toBeNull();
});
it("persists baseline, notes and consumption across launches", () => {
  notices.pending("1.0");
  notices.cache({ platform: "ios", version: "1.1", releaseNotes: ["说明"] });
  const next = new IosInstalledReleaseNotices({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } });
  expect(next.pending("1.1")?.releaseNotes).toEqual(["说明"]);
  next.markShown("1.1");
  expect(notices.pending("1.1")).toBeNull();
});
it("does not repeat when writes fail but reads still return an old baseline", () => {
  let fail = false;
  const store = new IosInstalledReleaseNotices({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { if (fail) throw Error(); data.set(key, value); } });
  store.pending("1.0"); fail = true;
  expect(store.pending("1.1")).not.toBeNull(); store.markShown("1.1");
  expect(store.pending("1.1")).toBeNull();
});
