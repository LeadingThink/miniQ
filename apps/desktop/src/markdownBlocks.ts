/**
 * Split streaming Markdown into top-level blocks so completed blocks keep their
 * parsed output while only the open tail is parsed again on each frame.
 *
 * A block boundary is a blank line outside fenced code and display math that
 * is followed by a line which cannot continue the previous block: indented
 * lines (list continuations, indented code) and the next item of a list stay
 * attached so a list is never split into separately numbered lists. Joining the result
 * reproduces the input exactly.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  let math = false;
  let afterBlank = false;
  let lastTopLevel = "";
  let hasContent = false;
  lines.forEach((line, index) => {
    const last = index === lines.length - 1;
    const boundary = afterBlank && !fence && !math && hasContent
      && line.trim() !== "" && !/^[ \t]/.test(line)
      && !(LIST_ITEM.test(line) && LIST_ITEM.test(lastTopLevel));
    if (boundary) {
      blocks.push(current.join("\n") + "\n");
      current = [];
      hasContent = false;
    }
    if (line.trim()) hasContent = true;
    if (!fence && !math && line.trim() && !/^[ \t]/.test(line)) lastTopLevel = line;
    current.push(line);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else if (math) {
      if (line.trim().endsWith("$$")) math = false;
    } else {
      fence = openingFence(line);
      if (!fence) math = opensMath(line);
    }
    afterBlank = !fence && !math && line.trim() === "";
    if (last) blocks.push(current.join("\n"));
  });
  return blocks;
}

const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

function openingFence(line: string) {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return match ? { marker: match[1][0], length: match[1].length } : null;
}

function closesFence(line: string, fence: { marker: string; length: number }) {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

function opensMath(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("$$")) return false;
  return trimmed === "$$" || !trimmed.slice(2).endsWith("$$");
}
