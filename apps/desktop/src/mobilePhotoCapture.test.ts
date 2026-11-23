import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const camera = vi.hoisted(() => ({
  getPhoto: vi.fn(),
  requestPermissions: vi.fn(),
}));

vi.mock("@capacitor/camera", () => ({
  Camera: camera,
  CameraResultType: { Uri: "uri" },
  CameraSource: { Camera: "CAMERA", Photos: "PHOTOS" },
}));

import { captureMobilePhoto } from "./mobilePhotoCapture";

describe("captureMobilePhoto", () => {
  beforeEach(() => {
    camera.getPhoto.mockReset();
    camera.requestPermissions.mockReset();
    vi.restoreAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requests camera permission and converts the captured URI to a File", async () => {
    camera.requestPermissions.mockResolvedValue({ camera: "granted", photos: "granted" });
    camera.getPhoto.mockResolvedValue({ webPath: "https://camera.test/photo", format: "jpeg" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["image"], { type: "image/jpeg" }), { status: 200 })));

    const file = await captureMobilePhoto();

    expect(camera.requestPermissions).toHaveBeenCalledWith({ permissions: ["camera"] });
    expect(camera.getPhoto).toHaveBeenCalledWith(expect.objectContaining({ source: "CAMERA", resultType: "uri" }));
    expect(file).toEqual(expect.any(File));
    expect(file?.type).toBe("image/jpeg");
  });

  it("uses the capture format when the camera returns a blob without a MIME type", async () => {
    camera.requestPermissions.mockResolvedValue({ camera: "granted" });
    camera.getPhoto.mockResolvedValue({ webPath: "https://camera.test/image", format: "png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["image"], { type: "" }), { status: 200 })));

    const file = await captureMobilePhoto();

    expect(camera.requestPermissions).toHaveBeenCalledWith({ permissions: ["camera"] });
    expect(camera.getPhoto).toHaveBeenCalledWith(expect.objectContaining({ source: "CAMERA" }));
    expect(file?.type).toBe("image/png");
  });

  it("treats cancelling the native picker as a no-op", async () => {
    camera.requestPermissions.mockResolvedValue({ camera: "granted" });
    camera.getPhoto.mockRejectedValue(new Error("User cancelled camera"));

    await expect(captureMobilePhoto()).resolves.toBeNull();
  });
});
