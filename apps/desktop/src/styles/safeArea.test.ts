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
});
