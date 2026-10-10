// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HighlightedCode, highlightLine, languageForPath, loadHighlighter, useLineHighlighter } from "./syntaxHighlight";

afterEach(cleanup);

function Line({ path, text }: { path: string; text: string }) {
  return <HighlightedCode text={text} highlight={useLineHighlighter(path)} />;
}

describe("syntax highlighting", () => {
  it("maps file extensions to grammars and falls back to plain text", () => {
    expect(languageForPath("src/App.tsx")).toBe("typescript");
    expect(languageForPath("C:\\repo\\main.RS")).toBe("rust");
    expect(languageForPath("Cargo.toml")).toBe("ini");
    expect(languageForPath("notes.unknownext")).toBeNull();
    expect(languageForPath("Makefile")).toBeNull();
    expect(languageForPath(".env")).toBeNull();
  });

  it("escapes source while highlighting tokens", async () => {
    const hljs = await loadHighlighter("typescript");
    const html = highlightLine(hljs, "typescript", "const tag = \"<b>\";");
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("renders plain text for unknown languages and highlights once the grammar loads", async () => {
    const plain = render(<Line path="data.unknownext" text="const x = 1" />);
    expect(plain.container.querySelector("code")?.innerHTML).toBe("const x = 1");
    plain.unmount();
    const view = render(<Line path="main.py" text="def run(): pass" />);
    expect(view.container.textContent).toBe("def run(): pass");
    await waitFor(() => expect(view.container.querySelector(".hljs-keyword")?.textContent).toBe("def"));
    expect(view.container.textContent).toBe("def run(): pass");
  });
});
