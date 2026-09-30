import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("..", import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

describe("safe area insets", () => {
  it("prefers Capacitor's injected insets over env() for every edge", () => {
    const css = readFileSync(new URL("./base.css", import.meta.url), "utf8");
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(css).toContain(
        `--safe-${edge}: var(--safe-area-inset-${edge}, env(safe-area-inset-${edge}, 0px));`,
      );
    }
  });

  it("reads safe areas only through the shared variables", () => {
    const offenders = cssFiles(srcRoot)
      .filter((path) => !path.endsWith(join("styles", "base.css")))
      .filter((path) => /env\(\s*safe-area-inset/.test(readFileSync(path, "utf8")))
      .map((path) => relative(srcRoot, path));
    expect(offenders).toEqual([]);
  });

  it("keeps the mobile top bar below the status bar despite the app-toolbar rule", () => {
    // shell.css styles `.statusbar.app-toolbar` with desktop padding; the mobile
    // rule must match that specificity or the header slides under the status bar.
    const shell = readFileSync(new URL("./shell.css", import.meta.url), "utf8");
    expect(shell).toMatch(/\.statusbar\.app-toolbar\s*\{[^}]*padding/);
    const remote = readFileSync(new URL("./remote.css", import.meta.url), "utf8");
    const rule = remote.match(
      /\.statusbar,\s*\.statusbar\.app-toolbar\s*\{([^}]*)\}/,
    );
    expect(rule?.[1]).toContain("max(8px, var(--safe-top))");
    const shellIndex = readFileSync(new URL("./base.css", import.meta.url), "utf8");
    expect(shellIndex).toMatch(/@import[^;]*shell\.css/);
  });
});
