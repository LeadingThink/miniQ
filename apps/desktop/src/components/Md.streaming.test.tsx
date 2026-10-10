// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const parsed: string[] = [];
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      parsed.push(String(props.children));
      return actual.default(props);
    },
  };
});

const { Md } = await import("./Md");

afterEach(() => { cleanup(); parsed.length = 0; });

it("parses only the open block of a growing stream", () => {
  const { rerender, container } = render(<Md streaming>{"# 标题\n\n第一段"}</Md>);
  expect(parsed).toEqual(["# 标题\n\n", "第一段"]);
  parsed.length = 0;
  act(() => rerender(<Md streaming>{"# 标题\n\n第一段继续\n\n- 列表"}</Md>));
  expect(parsed).toEqual(["第一段继续\n\n", "- 列表"]);
  parsed.length = 0;
  act(() => rerender(<Md streaming>{"# 标题\n\n第一段继续\n\n- 列表\n- 第二项"}</Md>));
  expect(parsed).toEqual(["- 列表\n- 第二项"]);
  expect(container.querySelectorAll("h1, p, li")).toHaveLength(4);
});

it("renders the same document as a complete message", () => {
  const text = "段落 `a.ts`\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n行内 \\(x\\)";
  // Separately parsed blocks only lack the newline text nodes between blocks.
  const html = (markup: string) => markup.replace(/>\n</g, "><");
  expect(html(renderToStaticMarkup(<Md streaming>{text}</Md>))).toBe(html(renderToStaticMarkup(<Md>{text}</Md>)));
});
