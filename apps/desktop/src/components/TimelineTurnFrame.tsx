import type { ReactNode } from "react";
import type { TimelineTurn } from "../timelineTurns";
import { searchRecordKeys } from "../timelineTurns";

/** One wrapper per turn, kept while the turn is windowed out. A windowed-out
 * turn keeps its measured height and exposes the user message and search keys
 * it contains, so the navigation rail, history anchors and search still find
 * it and can bring it back. */
export function TimelineTurnFrame({ turn, mounted, placeholderHeight, children }: {
  turn: TimelineTurn;
  mounted: boolean;
  placeholderHeight: (key: string) => number;
  children: ReactNode;
}) {
  if (mounted) return <div className="timeline-turn" data-turn-key={turn.key}>{children}</div>;
  return (
    <div
      className="timeline-turn is-windowed"
      data-turn-key={turn.key}
      data-window-placeholder=""
      style={{ height: placeholderHeight(turn.key) }}
      aria-hidden="true"
    >
      <div
        className="timeline-turn-stub"
        data-user-message-id={turn.userMessageId}
        data-history-anchor={turn.userMessageId ? `message:${turn.userMessageId}` : undefined}
        data-search-records={searchRecordKeys(turn.groups)}
      />
    </div>
  );
}
