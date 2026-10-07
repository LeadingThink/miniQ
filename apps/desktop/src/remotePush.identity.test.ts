// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

vi.mock("./remoteAccess", () => ({ loadRemoteCredentials: async () => ({ apiKey: "key" }) }));
vi.mock("./remoteCrypto", () => ({
  deriveRemoteIdentity: async () => ({ roomId: "room-a", encryptionKey: "key" }),
  decryptRemotePayload: async (_key: unknown, _nonce: string, ciphertext: string) => JSON.parse(ciphertext),
  deriveRemotePushKey: vi.fn(),
}));
import { pushTarget } from "./remotePush";

it("maps native origin identity into the selected-device target", async () => {
  expect(await pushTarget({ miniqSessionId: "same-session", miniqApprovalId: "approval-a", miniqRoomId: "room-a", miniqDesktopDeviceId: "desktop-a", miniqDeviceName: "办公电脑" }))
    .toEqual({ host: null, sessionId: "same-session", approvalId: "approval-a", targetDeviceId: "desktop-a", deviceName: "办公电脑" });
});

it("rejects native notifications from another account or without device identity", async () => {
  expect(await pushTarget({ miniqSessionId: "same-session", miniqRoomId: "room-b", miniqDesktopDeviceId: "desktop-a" })).toBeNull();
  expect(await pushTarget({ miniqSessionId: "same-session", miniqRoomId: "room-a" })).toBeNull();
});

it("preserves the encrypted origin and rejects a different account", async () => {
  const payload = { v: 2, roomId: "room-a", desktopDeviceId: "desktop-b", desktopDeviceName: "家中电脑", sessionId: "same-session", approvalId: "approval-b" };
  const data = (value: object) => ({ miniqNonce: "nonce", miniqCiphertext: JSON.stringify(value) });
  expect(await pushTarget(data(payload))).toEqual({ host: null, sessionId: "same-session", approvalId: "approval-b", targetDeviceId: "desktop-b", deviceName: "家中电脑" });
  expect(await pushTarget(data({ ...payload, deviceName: "旧名称" }))).toMatchObject({ deviceName: "家中电脑" });
  expect(await pushTarget(data({ ...payload, desktopDeviceName: undefined, deviceName: "旧名称" }))).toMatchObject({ deviceName: "旧名称" });
  expect(await pushTarget(data({ ...payload, roomId: "room-b" }))).toBeNull();
  expect(await pushTarget(data({ sessionId: "same-session", approvalId: "old-approval" }))).toBeNull();
});
