import type { Message, ToolCall } from "./types";
import { payloadText } from "./timelineModel";

/** A web page the session consulted through a search, fetch or browser tool. */
export interface WebSource {
  url: string;
  title?: string;
  domain: string;
  /** How the page entered the session; visited pages rank above search hits. */
  via: "visited" | "search";
}

export interface PullRequestRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function webUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function sourceOf(raw: string | undefined, title: string | undefined, via: WebSource["via"]): WebSource | undefined {
  const url = webUrl(raw);
  if (!url) return undefined;
  return { url: url.href, title, domain: url.hostname.replace(/^www\./, ""), via };
}

function callSources(call: ToolCall): WebSource[] {
  if (call.status !== "succeeded") return [];
  const input = record(parseJson(call.input));
  const output = record(parseJson(call.output));
  switch (call.toolName) {
    case "web_search": {
      const results = Array.isArray(output?.results) ? output.results : [];
      return results.flatMap((result) => {
        const item = record(result);
        const source = sourceOf(text(item?.url), text(item?.title), "search");
        return source ? [source] : [];
      });
    }
    case "web_fetch": {
      const source = sourceOf(text(output?.finalUrl) ?? text(input?.url), undefined, "visited");
      return source ? [source] : [];
    }
    case "browser_automation": {
      const action = text(input?.action);
      if (action !== "open" && action !== "navigate" && action !== "newTab") return [];
      const source = sourceOf(text(output?.url) ?? text(input?.url), text(output?.title), "visited");
      return source ? [source] : [];
    }
    default:
      return [];
  }
}

/** Web pages consulted in this session, one entry per URL, visited pages
 * first and otherwise in first-seen order. A later visit keeps the title an
 * earlier search result supplied. */
export function collectWebSources(toolCalls: readonly ToolCall[]): WebSource[] {
  const byUrl = new Map<string, WebSource>();
  for (const call of toolCalls) {
    for (const source of callSources(call)) {
      const known = byUrl.get(source.url);
      if (!known) byUrl.set(source.url, source);
      else byUrl.set(source.url, {
        ...known,
        title: known.title ?? source.title,
        via: known.via === "visited" || source.via === "visited" ? "visited" : "search",
      });
    }
  }
  const sources = [...byUrl.values()];
  return [...sources.filter((source) => source.via === "visited"), ...sources.filter((source) => source.via === "search")];
}

const PULL_REQUEST = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g;

/** GitHub pull requests mentioned by messages or tool results, deduplicated
 * by repository and number in first-seen order. */
export function detectPullRequests(messages: readonly Message[], toolCalls: readonly ToolCall[]): PullRequestRef[] {
  const found = new Map<string, PullRequestRef>();
  const scan = (value: string) => {
    for (const match of value.matchAll(PULL_REQUEST)) {
      const [, owner, repo, digits] = match;
      const number = Number(digits);
      const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
      if (!found.has(key)) found.set(key, { url: `https://github.com/${owner}/${repo}/pull/${number}`, owner, repo, number });
    }
  };
  for (const message of messages) if (message.role !== "system") scan(message.content);
  for (const call of toolCalls) if (call.output !== undefined) scan(payloadText(call.output));
  return [...found.values()];
}
