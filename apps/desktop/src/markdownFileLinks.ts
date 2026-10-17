import type { Link, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { looksLikeFileReference } from "./localFiles";

const parser = unified().use(remarkParse);

/** Accept only a complete local link, not a command containing link syntax. */
function quotedFileLink(value: string): Link | null {
  if (!value.trim().startsWith("[")) return null;
  const tree = parser.parse(value.trim());
  const paragraph = tree.children[0];
  if (tree.children.length !== 1 || paragraph?.type !== "paragraph") return null;
  const link = paragraph.children[0];
  if (paragraph.children.length !== 1 || link?.type !== "link") return null;
  return looksLikeFileReference(link.url) ? link : null;
}

/** Models sometimes quote the whole file link rather than just its label. */
export function remarkQuotedFileLinks() {
  return (tree: Root) => {
    visit(tree, "inlineCode", (node, index, parent) => {
      if (!parent || index === undefined) return;
      const link = quotedFileLink(node.value);
      if (link) parent.children[index] = { ...link, position: node.position };
    });
  };
}

/** Use Markdown syntax for both the renderer and file cards; skip code blocks. */
export function markdownFileLinks(content: string): string[] {
  const tree = parser.parse(content);
  remarkQuotedFileLinks()(tree);
  const paths: string[] = [];
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  visit(tree, ["link", "linkReference"], (node) => {
    const url = node.type === "link" ? node.url : node.type === "linkReference"
      ? definitions.get(node.identifier) : undefined;
    if (url && looksLikeFileReference(url)) paths.push(url);
  });
  return paths;
}
