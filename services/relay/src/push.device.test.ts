import { describe, expect, it } from "vitest";
import { apnsCollapseId, apnsPayload, jpushPayload, parsePush } from "./push.js";

describe("push device identity", () => {
  const wire = { kind: "attention", collapseId: "123", nonce: "abcdefghijklmnop", ciphertext: "a".repeat(100) };

  it("keeps the origin in both native transports", () => {
    const notification = parsePush({ ...wire, desktopDeviceId: "desktop-a" })!;
    expect(notification.desktopDeviceId).toBe("desktop-a");
    expect(apnsPayload(notification)).toMatchObject({ miniq: { v: 2, desktopDeviceId: "desktop-a" } });
    expect(jpushPayload({ deviceId: "phone", platform: "jpush", token: "token", environment: "production", updatedAt: 0 }, notification))
      .toMatchObject({ notification: { android: { extras: { miniqDesktopDeviceId: "desktop-a" } } } });
  });

  it("retains v1 compatibility and rejects malformed identity", () => {
    expect(apnsPayload(parsePush(wire)!)).toMatchObject({ miniq: { v: 1 } });
    expect(parsePush({ ...wire, desktopDeviceId: "../bad" })).toBeNull();
  });
});

it("matches broker device ID length boundaries", () => {
  const wire = { kind: "attention", collapseId: "123", nonce: "abcdefghijklmnop", ciphertext: "a".repeat(100) };
  for (const length of [8, 80]) expect(parsePush({ ...wire, desktopDeviceId: "a".repeat(length) })).not.toBeNull();
  for (const length of [7, 81, 128]) expect(parsePush({ ...wire, desktopDeviceId: "a".repeat(length) })).toBeNull();
});

it("isolates equal collapse IDs by desktop in APNs and JPush APNs options", () => {
  for (const kind of ["attention", "desktop_offline"] as const) {
    const a = { kind, collapseId: "a".repeat(64), desktopDeviceId: "desktop-a" };
    const b = { ...a, desktopDeviceId: "desktop-b" };
    expect(apnsCollapseId(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(apnsCollapseId(a)).not.toBe(apnsCollapseId(b));
    expect(apnsCollapseId(a)).toBe(apnsCollapseId({ ...a }));
    expect(jpushPayload({ deviceId: "phone", platform: "jpush", token: "token", environment: "production", updatedAt: 0 }, a))
      .toMatchObject({ options: { apns_collapse_id: apnsCollapseId(a) } });
  }
  expect(apnsCollapseId({ kind: "attention", collapseId: "123" })).toBe("123");
});
