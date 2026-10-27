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

import { pickMobileImage } from "./mobileImagePicker";

describe("pickMobileImage", () => {
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

    const file = await pickMobileImage("camera");

    expect(camera.requestPermissions).toHaveBeenCalledWith({ permissions: ["camera"] });
    expect(camera.getPhoto).toHaveBeenCalledWith(expect.objectContaining({ source: "CAMERA", resultType: "uri" }));
    expect(file).toEqual(expect.any(File));
    expect(file?.type).toBe("image/jpeg");
  });

  it("does not request camera permission for the photo library", async () => {
    camera.getPhoto.mockResolvedValue({ webPath: "https://camera.test/image", format: "png" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["image"], { type: "" }), { status: 200 })));

    const file = await pickMobileImage("photos");

    expect(camera.requestPermissions).not.toHaveBeenCalled();
    expect(camera.getPhoto).toHaveBeenCalledWith(expect.objectContaining({ source: "PHOTOS" }));
    expect(file?.type).toBe("image/png");
  });

  it("treats cancelling the native picker as a no-op", async () => {
    camera.getPhoto.mockRejectedValue(new Error("User cancelled photos app"));

    await expect(pickMobileImage("photos")).resolves.toBeNull();
  });
});
