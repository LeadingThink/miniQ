import { expect, it } from "vitest";
import { parseUnifiedDiff } from "./unifiedDiff";

function diffOf(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

it("parses hunks with old and new line numbers", () => {
  const [file] = parseUnifiedDiff(diffOf(
    "diff --git a/backend/.env.example b/backend/.env.example",
    "index 770a126..02af9fdf 100644",
    "--- a/backend/.env.example",
    "+++ b/backend/.env.example",
    "@@ -14,4 +14,6 @@",
    " API_HOST=0.0.0.0",
    "-API_PORT=8000",
    "+API_PORT=8001",
    "+DEBUG=True",
    " # CORS Configuration",
    "\\ No newline at end of file",
  ));

  expect(file.path).toBe("backend/.env.example");
  expect(file.binary).toBe(false);
  expect(file.hunks).toHaveLength(1);
  expect(file.hunks[0].lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
    ["context", 14, 14],
    ["deletion", 15, null],
    ["addition", null, 15],
    ["addition", null, 16],
    ["context", 16, 17],
  ]);
  expect(file.hunks[0].lines[1].content).toBe("API_PORT=8000");
});

it("splits multiple files and flags binary payloads", () => {
  const files = parseUnifiedDiff(diffOf(
    "diff --git a/grid9/r1c1.png b/grid9/r1c1.png",
    "index 1111111..2222222 100644",
    "Binary files a/grid9/r1c1.png and b/grid9/r1c1.png differ",
    "diff --git a/src/a.ts b/src/b.ts",
    "similarity index 100%",
    "rename from src/a.ts",
    "rename to src/b.ts",
    "diff --git a/src/c.ts b/src/c.ts",
    "--- a/src/c.ts",
    "+++ b/src/c.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ));

  expect(files.map((file) => [file.path, file.binary])).toEqual([
    ["grid9/r1c1.png", true],
    ["src/b.ts", false],
    ["src/c.ts", false],
  ]);
  expect(files[1].note).toBe("重命名自 src/a.ts → src/b.ts");
});

it("keeps empty context lines inside a hunk", () => {
  const [file] = parseUnifiedDiff(diffOf(
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,3 @@",
    " first",
    "",
    "-last",
    "+final",
  ));

  expect(file.hunks[0].lines.map((line) => line.kind)).toEqual([
    "context",
    "context",
    "deletion",
    "addition",
  ]);
  expect(file.hunks[0].lines[1].content).toBe("");
});

it("returns nothing for payloads without diff headers", () => {
  expect(parseUnifiedDiff("worktree change")).toEqual([]);
  expect(parseUnifiedDiff("")).toEqual([]);
});
