import GithubSlugger from "github-slugger";
import type { Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { normalizeMathWithSourceLines } from "./markdownMath";

export interface OutlineHeading {
  id: string;
  text: string;
  depth: number;
  line: number;
}

function assignHeadingIds(tree: Root): OutlineHeading[] {
  const slugger = new GithubSlugger();
  const headings: OutlineHeading[] = [];
  visit(tree, "heading", (node) => {
    const text = toString(node);
    const id = slugger.slug(text || "section");
    node.data = {
      ...node.data,
      hProperties: { ...node.data?.hProperties, id },
    };
    headings.push({
      id,
      text,
      depth: node.depth,
      line: node.position?.start.line ?? 1,
    });
  });
  return headings;
}

export function remarkHeadingIds() {
  return (tree: Root) => {
    assignHeadingIds(tree);
  };
}

export function markdownOutline(content: string): OutlineHeading[] {
  const normalized = normalizeMathWithSourceLines(content);
  return assignHeadingIds(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath)
      .parse(normalized.content)
  ).map((heading) => ({
    ...heading,
    line: normalized.sourceLines[heading.line - 1] ?? heading.line,
  }));
}
