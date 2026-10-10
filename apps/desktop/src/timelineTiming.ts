import type { AnchoredTurnTiming, Message, TurnPlan } from "./types";
import type { TimelineGroup } from "./timelineModel";

export function timelineGroupKey(group: TimelineGroup): string {
  return group.kind === "message" ? `message:${group.message.id}`
    : group.kind === "artifact" ? `artifact:${group.artifact.id}` : `tool:${group.calls[0].id}`;
}

/** Map each turn plan to the last visible record of the turn that published it,
 * so a finished plan stays with its turn instead of floating below later turns. */
export function timelineTurnPlanEnds(groups: TimelineGroup[], turnPlans: readonly TurnPlan[]): Map<string, TurnPlan> {
  const ends = new Map<string, TurnPlan>();
  if (!turnPlans.length) return ends;
  const byAnchor = new Map(turnPlans.map((turn) => [turn.anchorMessageId, turn]));
  let current: TurnPlan | undefined;
  let last: string | undefined;
  for (const group of groups) {
    if (group.kind === "message" && group.message.role === "user") {
      if (last && current) ends.set(last, current);
      current = byAnchor.get(group.message.id);
    }
    last = timelineGroupKey(group);
  }
  if (last && current) ends.set(last, current);
  return ends;
}

export function latestMessageTiming(messages: Message[]): AnchoredTurnTiming | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") return message.turnTiming ? { messageId: message.id, timing: message.turnTiming } : null;
  }
  return null;
}
