import type { Artifact, Message, PlanTask, ToolCall } from "./types";
import { createTimelineItems, payloadText } from "./timelineModel";
import { downloadBlob } from "./downloadBlob";

export interface SessionExport {
  title: string;
  messages: Message[];
  toolCalls: ToolCall[];
  plan: PlanTask[];
  artifacts: Artifact[];
}

function fence(content: string, language: string): string {
  const runs = content.match(/`+/g) ?? [];
  const marker = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${marker}${language}\n${content}\n${marker}`;
}

export function exportMarkdown(data: SessionExport): string {
  const entries = createTimelineItems(data.messages, data.toolCalls, true).map(
    (entry) => {
      if (entry.kind === "message") {
        const message = entry.message;
        const attachments = message.attachments
          ?.map((file) => `- ${file.path}`)
          .join("\n");
        return `## ${message.role} · ${message.createdAt}\n\n${
          message.content
        }${attachments ? `\n\n### Attachments\n\n${attachments}` : ""}`;
      }
      const call = entry.call;
      return `## ${call.toolName} · ${call.status} · ${
        call.createdAt
      }\n\n### Input\n\n${fence(
        payloadText(call.input),
        "json",
      )}\n\n### Output\n\n${fence(payloadText(call.output), "json")}`;
    },
  );
  const plan = data.plan
    .map(
      (task) =>
        `- [${task.status === "completed" ? "x" : " "}] ${task.content}`,
    )
    .join("\n");
  const artifacts = data.artifacts
    .map((artifact) => `- ${artifact.title}: ${artifact.path}`)
    .join("\n");
  return `# ${data.title}\n\n${entries.join(
    "\n\n",
  )}\n\n## Plan\n\n${plan}\n\n## Artifacts\n\n${artifacts}\n`;
}

export function exportFilename(title: string): string {
  const name = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "");
  // Keep the complete title inside the export; avoid platform filename limits
  // without silently chopping the user's title into a different one.
  if (
    !name ||
    new TextEncoder().encode(name).length > 200 ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    return "miniq-session";
  return name;
}

export function downloadSession(data: SessionExport, format: "md" | "json") {
  const content =
    format === "md" ? exportMarkdown(data) : JSON.stringify(data, null, 2);
  downloadBlob(
    new Blob([content], {
      type:
        format === "md"
          ? "text/markdown;charset=utf-8"
          : "application/json;charset=utf-8",
    }),
    `${exportFilename(data.title)}.${format}`,
  );
}
