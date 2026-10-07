import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PushRegistry, type PushRegistration } from "./push.js";

it("discards persisted legacy registrations without assigning them to a desktop", () => {
  const directory = mkdtempSync(join(tmpdir(), "miniq-legacy-push-"));
  try {
    const file = join(directory, "push.json");
    const registration: PushRegistration = {
      deviceId: "mobile-aaaa", platform: "apns", token: "a".repeat(64),
      environment: "production", updatedAt: 1,
    };
    const records = {
      room: [registration], other: [registration],
      "room:desktop-aaaa": [registration], "room:desktop-bbbb": [registration],
    };
    writeFileSync(file, JSON.stringify(records));
    const registry = new PushRegistry(file);
    expect(registry.discardLegacyRoom("room:desktop-aaaa")).toBe(0);
    expect(registry.discardLegacyRoom("room")).toBe(1);
    expect(registry.discardLegacyRoom("room")).toBe(0);
    expect(registry.list("room")).toEqual([]);
    const restored = new PushRegistry(file);
    expect(restored.list("room")).toEqual([]);
    for (const scope of ["other", "room:desktop-aaaa", "room:desktop-bbbb"]) {
      expect(restored.list(scope)).toEqual([registration]);
    }
    restored.upsert("room:desktop-aaaa", { ...registration, token: "b".repeat(64) });
    expect(new PushRegistry(file).list("room:desktop-aaaa")[0].token).toBe("b".repeat(64));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
