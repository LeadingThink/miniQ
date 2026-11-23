import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const ios = readFileSync(new URL("../ios/App/App/MiniqUploadPicker.swift", import.meta.url), "utf8");
const android = readFileSync(new URL("../android/app/src/main/java/com/leadingthink/miniq/MiniqFilesPlugin.java", import.meta.url), "utf8");

it("allows mixed photos and videos in the iOS library without conversion or a selection cap", () => {
  expect(ios).toMatch(/configuration\.filter = \.any\(of: \[\.images, \.videos\]\)/);
  expect(ios).toContain("configuration.selectionLimit = 0");
  expect(ios).toContain("configuration.selection = .ordered");
  expect(ios).toContain("configuration.preferredAssetRepresentationMode = .current");
});

it("prefers the iOS movie file over its thumbnail and copies it before provider access expires", () => {
  expect(ios).toMatch(/types\.first\(where: \{ \$0\.conforms\(to: \.movie\) \}\)\s*\?\? types\.first\(where: \{ \$0\.conforms\(to: \.image\) \}\)/);
  expect(ios).toContain("loadFileRepresentation(forTypeIdentifier: type.identifier)");
  expect(ios).toContain("name += \".\" + url.pathExtension");
  expect(ios).toMatch(/self\.staged\.append\(try self\.cache\.copy[\s\S]*?self\.worker\.async \{ self\.copyMedia/);
  expect(ios).toContain("worker.sync(execute: copy)");
  expect(ios).toContain("cancellation.onCancel { progress.cancel() }");
});

it("requests both image and video documents on Android while keeping generic files unrestricted", () => {
  expect(android).toContain("new Intent(Intent.ACTION_OPEN_DOCUMENT)");
  expect(android).toContain("intent.addCategory(Intent.CATEGORY_OPENABLE)");
  expect(android).toContain('intent.setType("*/*")');
  expect(android).toMatch(/if \("photos"\.equals\(kind\)\) \{\s*intent\.putExtra\(Intent\.EXTRA_MIME_TYPES, new String\[\] \{ "image\/\*", "video\/\*" \}\);\s*\}/);
  expect(android).toContain("intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)");
  expect(android).toContain("Intent.FLAG_GRANT_READ_URI_PERMISSION");
});

it("imports saved WeChat documents through the existing platform document pickers", () => {
  expect(ios).toContain("UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)");
  expect(ios).toContain("documents.allowsMultipleSelection = true");
  expect(ios).toContain("source.startAccessingSecurityScopedResource()");
  expect(ios).toContain("source.stopAccessingSecurityScopedResource()");
  expect(android).toContain('intent.setType("*/*")');
  expect(android).not.toContain('setPackage("com.tencent.mm")');
  expect(android).not.toContain("MANAGE_EXTERNAL_STORAGE");
});
