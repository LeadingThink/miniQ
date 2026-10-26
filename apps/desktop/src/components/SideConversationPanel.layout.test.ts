// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps settings above the side conversation on narrow layouts", () => {
  const styles = [
    "src/styles/interactions.css",
    "src/styles/theme-picker.css",
    "src/components/SideConversationPanel.css",
  ].map((path) => readFileSync(resolve(process.cwd(), path), "utf8")).join("\n");
  const narrowSideLayer = styles.match(/@media \(max-width: 820px\)[\s\S]*?\.side-conversation\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1];
  const settingsLayers = [...styles.matchAll(/\.settings-overlay\s*\{[\s\S]*?z-index:\s*(\d+)/g)];
  const settingsLayer = settingsLayers.at(-1)?.[1];

  expect(narrowSideLayer).toBeDefined();
  expect(settingsLayer).toBeDefined();
  expect(Number(settingsLayer)).toBeGreaterThan(Number(narrowSideLayer));
});