import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// AppStatus.css loads after shell.css and sets `.statusbar > * { flex-shrink: 0 }`.
// The title needs a more specific rule, or long titles push the right-side
// actions off narrow phone screens.
it("lets the toolbar title shrink so the right-side actions stay on screen", () => {
  const css = readFileSync(new URL("./shell.css", import.meta.url), "utf8");
  const title = css.match(/\.statusbar\.app-toolbar > \.app-toolbar-title \{([^}]*)\}/)?.[1] ?? "";
  expect(title).toMatch(/flex:\s*1 1 auto/);
  expect(title).toMatch(/min-width:\s*0/);
  const actions = css.match(/\.statusbar\.app-toolbar > \.app-toolbar-actions \{([^}]*)\}/)?.[1] ?? "";
  expect(actions).toMatch(/flex:\s*none/);
});
