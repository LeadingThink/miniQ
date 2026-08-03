interface MarkdownState {
  codeFence: { marker: string; length: number } | null;
  inlineCodeLength: number | null;
}

const MATH_DELIMITERS: Record<string, string> = {
  "(": "$",
  ")": "$",
  "[": "\n$$\n",
  "]": "\n$$\n",
};

function fenceAtStart(line: string) {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return { marker: match[1][0], length: match[1].length };
}

function closesFence(line: string, fence: NonNullable<MarkdownState["codeFence"]>) {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(
    match && match[1][0] === fence.marker && match[1].length >= fence.length,
  );
}

function normalizeLine(line: string, state: MarkdownState) {
  let output = "";
  let index = 0;

  while (index < line.length) {
    const character = line[index];
    if (character === "`") {
      let runEnd = index + 1;
      while (line[runEnd] === "`") runEnd += 1;
      const runLength = runEnd - index;
      output += line.slice(index, runEnd);
      if (state.inlineCodeLength === null) state.inlineCodeLength = runLength;
      else if (state.inlineCodeLength === runLength) state.inlineCodeLength = null;
      index = runEnd;
      continue;
    }

    if (state.inlineCodeLength === null && character === "\\") {
      let runEnd = index + 1;
      while (line[runEnd] === "\\") runEnd += 1;
      const slashCount = runEnd - index;
      const replacement = MATH_DELIMITERS[line[runEnd]];
      if (slashCount === 1 && replacement) {
        output += replacement;
        index = runEnd + 1;
        continue;
      }
      output += line.slice(index, runEnd);
      index = runEnd;
      continue;
    }

    if (state.inlineCodeLength === null && line.startsWith("$$", index)) {
      output += "\n$$\n";
      index += 2;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

/** Converts Codex-style LaTeX delimiters without touching Markdown code. */
export function normalizeMathDelimiters(markdown: string): string {
  const state: MarkdownState = { codeFence: null, inlineCodeLength: null };
  const parts = markdown.split(/(\r\n|\n|\r)/);

  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      if (state.codeFence) {
        if (closesFence(part, state.codeFence)) state.codeFence = null;
        return part;
      }

      if (state.inlineCodeLength === null) {
        const fence = fenceAtStart(part);
        if (fence) {
          state.codeFence = fence;
          return part;
        }
        if (/^(?: {4}|\t)/.test(part)) return part;
      }

      return normalizeLine(part, state);
    })
    .join("");
}
