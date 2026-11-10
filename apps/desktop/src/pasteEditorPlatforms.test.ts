import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps paste viewing and editing in the shared WebView UI without native permissions", () => {
  const editor = readFileSync(new URL("./components/PasteEditor.tsx", import.meta.url), "utf8");
  const field = readFileSync(new URL("./components/ComposerField.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./components/PasteEditor.css", import.meta.url), "utf8");
  expect(field).toContain("<PasteEditor");
  expect(field).toContain('aria-haspopup="dialog"');
  expect(editor).toContain("<Dialog");
  expect(editor).toContain('aria-label="完整文本"');
  expect(editor).not.toMatch(/@tauri-apps|@capacitor|navigator\.clipboard|invoke\(|fetch\(/);
  expect(styles).toMatch(/max-height:\s*100%/);
  expect(styles).toMatch(/overflow:\s*auto/);
  expect(styles).not.toMatch(/\.platform-|\.native-mobile/);
});