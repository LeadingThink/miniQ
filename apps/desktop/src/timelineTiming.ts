import type { AnchoredTurnTiming, Message, TurnTiming } from "./types";
import type { TimelineGroup } from "./timelineModel";

export function timelineGroupKey(group: TimelineGroup): string {
  return group.kind === "message" ? `message:${group.message.id}`
    : group.kind === "artifact" ? `artifact:${group.artifact.id}` : `tool:${group.calls[0].id}`;
}

/** Attach one summary to the last visible record of each recorded turn.
 * Never infer an old turn's duration from message gaps or sum parallel tools. */
export function timelineTurnEnds(groups: TimelineGroup[], latest?: AnchoredTurnTiming | null): Map<string, TurnTiming> {
  const ends = new Map<string, TurnTiming>();
  let current: TurnTiming | undefined;
  let last: string | undefined;
  for (const group of groups) {
    if (group.kind === "message" && group.message.role === "user") {
      if (last && current && current.status !== "running") ends.set(last, current);
      current = group.message.id === latest?.messageId ? latest.timing : group.message.turnTiming;
    }
    // The remote page may begin halfway through the most recent turn.
    if (!current && latest && Date.parse(group.at) >= Date.parse(latest.timing.startedAt)
      && !(group.kind === "message" && group.message.role === "user" && group.message.id !== latest.messageId)) {
      current = latest.timing;
    }
    last = timelineGroupKey(group);
  }
  if (last && current && current.status !== "running") ends.set(last, current);
  return ends;
}

export function latestMessageTiming(messages: Message[]): AnchoredTurnTiming | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return message.turnTiming ? { messageId: message.id, timing: message.turnTiming } : null;
  }
  return null;
}
