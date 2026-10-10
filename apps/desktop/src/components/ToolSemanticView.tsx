import { useState, type ReactNode } from "react";
import type { ToolCall } from "../types";
import { openExternalUrl, parseExternalUrl } from "../externalLinks";
import { additionLines, lineDiff, operationDiffLines, parseCodexPatch, type InlineDiffLine } from "./lineDiff";
import { HighlightedCode, useLineHighlighter } from "./syntaxHighlight";
import "./ToolSemanticView.css";

/** Lines shown before "显示全部". Nothing is dropped; the rest is one click away. */
export const PREVIEW_LINES = 20;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function outputLines(value: string): string[] {
  if (!value) return [];
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function ShowAll({ total, expanded, onToggle }: { total: number; expanded: boolean; onToggle: () => void }) {
  if (total <= PREVIEW_LINES) return null;
  return (
    <button type="button" className="ghost tool-show-all" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? "收起" : `显示全部（${total} 行）`}
    </button>
  );
}

interface TerminalLine { text: string; stderr: boolean }

export function TerminalOutput({ command, stdout, stderr, exitCode, timedOut }: {
  command: string;
  stdout: string;
  stderr: string;
  exitCode?: unknown;
  timedOut?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines: TerminalLine[] = [
    ...outputLines(stdout).map((line) => ({ text: line, stderr: false })),
    ...outputLines(stderr).map((line) => ({ text: line, stderr: true })),
  ];
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const failedExit = typeof exitCode === "number" && exitCode !== 0;
  return (
    <section className="tool-terminal" aria-label="命令输出">
      <pre className="tool-terminal-output">
        <span className="tool-terminal-command">
          <i aria-hidden="true">$ </i>
          {command}
        </span>
        {visible.map((line, index) => (
          <span key={index} className={line.stderr ? "is-stderr" : undefined}>{line.text || " "}</span>
        ))}
        {(failedExit || timedOut) && (
          <span className="tool-terminal-exit">{timedOut ? "命令超时" : `退出码 ${String(exitCode)}`}</span>
        )}
      </pre>
      <ShowAll total={lines.length} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
    </section>
  );
}

export function InlineDiff({ path, lines, label }: { path: string; lines: InlineDiffLine[]; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const highlight = useLineHighlighter(path);
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const additions = lines.filter((line) => line.kind === "addition").length;
  const deletions = lines.filter((line) => line.kind === "deletion").length;
  return (
    <section className="tool-inline-diff" aria-label={`${path} 的改动`}>
      <header>
        <span className="tool-semantic-path" title={path}>{path}</span>
        {label && <small>{label}</small>}
        <b className="diff-add">+{additions}</b>
        <i className="diff-delete">-{deletions}</i>
      </header>
      {lines.length > 0 && (
        <div className="tool-inline-diff-lines">
          {visible.map((line, index) => (
            <div key={index} className={`tool-diff-line ${line.kind}`}>
              <span className="diff-sign" aria-hidden="true">
                {line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}
              </span>
              <HighlightedCode text={line.content} highlight={highlight} />
            </div>
          ))}
        </div>
      )}
      <ShowAll total={lines.length} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
    </section>
  );
}

function ShellView({ call }: { call: ToolCall }) {
  const input = record(call.input);
  const output = record(call.output);
  if (call.toolName === "shell_batch") {
    const commands = Array.isArray(input.commands) ? input.commands.map(text) : [];
    const results = Array.isArray(output.output) ? output.output.map(record) : [];
    return (
      <>
        {commands.map((command, index) => {
          const result = results[index] ?? {};
          const outcome = record(result.outcome);
          return (
            <TerminalOutput
              key={index}
              command={command}
              stdout={text(result.stdout)}
              stderr={text(result.stderr)}
              exitCode={outcome.exit_code}
              timedOut={outcome.type === "timeout"}
            />
          );
        })}
      </>
    );
  }
  return (
    <TerminalOutput
      command={text(input.command)}
      stdout={text(output.stdout)}
      stderr={text(output.stderr)}
      exitCode={output.exitCode}
      timedOut={output.timedOut === true}
    />
  );
}

/** "第 a-b 行，共 n 行" for a file_read call, from its input and result. */
export function readRangeLabel(input: unknown, output: unknown): string {
  const request = record(input);
  const result = record(output);
  const offset = typeof result.offset === "number" ? result.offset
    : typeof request.offset === "number" ? request.offset : 1;
  const total = typeof result.totalLines === "number" ? result.totalLines : null;
  if (typeof result.content === "string") {
    const count = outputLines(result.content).length;
    if (count === 0) return total === null ? "空内容" : `共 ${total} 行，未读取内容`;
    const range = `第 ${offset}-${offset + count - 1} 行`;
    return total === null ? range : `${range}，共 ${total} 行`;
  }
  if (typeof request.limit === "number") return `第 ${offset}-${offset + request.limit - 1} 行`;
  return offset > 1 ? `从第 ${offset} 行起` : "全文";
}

function FileReadView({ call }: { call: ToolCall }) {
  const path = text(record(call.input).path) || text(record(call.output).path);
  return (
    <div className="tool-semantic-row">
      <span className="tool-semantic-path" title={path}>{path}</span>
      <small>{readRangeLabel(call.input, call.output)}</small>
    </div>
  );
}

function EditView({ call }: { call: ToolCall }) {
  const input = record(call.input);
  const path = text(input.path);
  switch (call.toolName) {
    case "file_edit":
      return (
        <InlineDiff
          path={path}
          lines={lineDiff(text(input.oldString), text(input.newString))}
          label={input.replaceAll === true ? "全部替换" : undefined}
        />
      );
    case "file_patch": {
      const edits = Array.isArray(input.edits) ? input.edits.map(record) : [];
      return (
        <InlineDiff
          path={path}
          lines={edits.flatMap((edit) => lineDiff(text(edit.oldString), text(edit.newString)))}
          label={`${edits.length} 处修改`}
        />
      );
    }
    case "file_write":
      return <InlineDiff path={path} lines={additionLines(text(input.content))} label="写入全文" />;
    case "apply_patch": {
      const operation = record(input.operation);
      if (typeof operation.path === "string") {
        const target = text(operation.new_path) || operation.path;
        return <InlineDiff path={target} lines={operationDiffLines(text(operation.diff))} label={text(operation.type)} />;
      }
      return (
        <>
          {parseCodexPatch(text(input.patch)).map((file, index) => (
            <InlineDiff key={`${file.path}:${index}`} path={file.path} lines={file.lines} label={file.action} />
          ))}
        </>
      );
    }
    default:
      return null;
  }
}

function ExternalLink({ href, children }: { href: string; children: string }) {
  const url = parseExternalUrl(href);
  if (!url) return <span>{children}</span>;
  return (
    <a
      href={url.href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void openExternalUrl(url).catch(() => undefined);
      }}
    >
      {children}
    </a>
  );
}

function WebSearchView({ call }: { call: ToolCall }) {
  const results = Array.isArray(record(call.output).results) ? (record(call.output).results as unknown[]).map(record) : [];
  return (
    <div className="tool-web">
      <div className="tool-semantic-row">
        <span>搜索</span>
        <strong>{text(record(call.input).query)}</strong>
        {call.output !== undefined && call.output !== null && <small>{results.length} 条结果</small>}
      </div>
      {results.length > 0 && (
        <ol className="tool-web-results">
          {results.map((result, index) => (
            <li key={index}>
              <ExternalLink href={text(result.url)}>{text(result.title) || text(result.url)}</ExternalLink>
              <small>{text(result.url)}</small>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function WebFetchView({ call }: { call: ToolCall }) {
  const input = record(call.input);
  const output = record(call.output);
  const url = text(output.finalUrl) || text(input.url);
  const content = text(output.content);
  const details = [
    typeof output.status === "number" ? `HTTP ${output.status}` : "",
    text(output.contentType),
    content ? `${content.length.toLocaleString()} 字符` : "",
    output.truncated === true ? "内容已截断" : "",
  ].filter(Boolean);
  return (
    <div className="tool-web">
      <div className="tool-semantic-row">
        <ExternalLink href={url}>{url}</ExternalLink>
      </div>
      {details.length > 0 && <small className="tool-semantic-meta">{details.join(" · ")}</small>}
    </div>
  );
}

const VIEWS: Record<string, (props: { call: ToolCall }) => ReactNode> = {
  shell_run: ShellView,
  shell_batch: ShellView,
  file_read: FileReadView,
  file_edit: EditView,
  file_patch: EditView,
  file_write: EditView,
  apply_patch: EditView,
  web_search: WebSearchView,
  web_fetch: WebFetchView,
};

/** The default expanded view of a step: what it did, not its raw JSON. */
export function ToolSemanticView({ call }: { call: ToolCall }) {
  const View = VIEWS[call.toolName];
  const error = text(record(call.output).error) || (typeof call.output === "string" && call.status === "failed" ? call.output : "");
  return (
    <>
      {View && <View call={call} />}
      {error && <div className="tool-semantic-error" role="alert">{error}</div>}
    </>
  );
}
