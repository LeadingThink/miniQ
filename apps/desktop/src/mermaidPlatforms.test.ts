import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ships Mermaid through the Tauri and Capacitor WebView entry points", () => {
  const tauri = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  expect(tauri.build.frontendDist).toBe("../dist");

  const capacitor = readFileSync(
    new URL("../capacitor.config.ts", import.meta.url),
    "utf8",
  );
  expect(capacitor).toMatch(/webDir:\s*["']dist["']/);

  const androidEntry = readFileSync(
    new URL(
      "../android/app/src/main/java/com/leadingthink/miniq/MainActivity.java",
      import.meta.url,
    ),
    "utf8",
  );
  expect(androidEntry).toContain("extends BridgeActivity");

  const iosPackage = readFileSync(
    new URL("../ios/App/CapApp-SPM/Package.swift", import.meta.url),
    "utf8",
  );
  expect(iosPackage).toContain("capacitor-swift-pm");

  const iosEntry = readFileSync(
    new URL("../ios/App/App/MainViewController.swift", import.meta.url),
    "utf8",
  );
  expect(iosEntry).toContain("CAPBridgeViewController");
});