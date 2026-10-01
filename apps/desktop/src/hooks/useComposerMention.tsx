import { useEffect, useId, useState, type KeyboardEvent, type RefObject } from "react";
import {
  applyMention,
  filterMentionFiles,
  mentionToken,
  type MentionFile,
} from "../composerMention";
import { clampMenuIndex, moveMenuIndex } from "../menuNavigation";
import type { RpcClient } from "../rpc";
import { MentionMenu } from "../components/MentionMenu";
import { useMentionFiles } from "./useMentionFiles";

/** `@` file mentions: token detection, candidate popover and keyboard. */
export function useComposerMention(props: {
  draft: string;
  caret: number;
  enabled: boolean;
  client?: RpcClient;
  sessionId?: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setDraft: (value: string) => void;
  /** Moves the caret after the new draft is committed. */
  placeCaret: (cursor: number) => void;
}) {
  const id = useId();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const available = props.enabled && !!props.client && !!props.sessionId;
  const token = available ? mentionToken(props.draft, props.caret) : null;
  const dismissalKey = token ? `${props.sessionId}:${token.start}:${props.draft}` : "";
  const active = token !== null && dismissed !== dismissalKey;
  const source = useMentionFiles(props.client, props.sessionId, active);
  const query = token?.query ?? "";
  const visible = active ? filterMentionFiles(source.files, query) : [];
  const index = clampMenuIndex(activeIndex, visible.length);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, token?.start]);

  useEffect(() => {
    if (!active) return;
    const closeOutside = (event: PointerEvent) => {
      if (!props.inputRef.current?.closest(".composer-card")?.contains(event.target as Node))
        setDismissed(dismissalKey);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [active, dismissalKey, props.inputRef]);

  const pick = (file: MentionFile) => {
    if (!token) return;
    const result = applyMention(props.draft, token, file.path);
    props.setDraft(result.value);
    props.placeCaret(result.cursor);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!active || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(dismissalKey);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (visible.length === 0) return false;
      event.preventDefault();
      setActiveIndex(moveMenuIndex(index, visible.length, event.key === "ArrowDown" ? 1 : -1));
      return true;
    }
    if (
      (event.key === "Enter" || event.key === "Tab") &&
      !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    ) {
      if (index < 0 || !visible[index]) return false;
      event.preventDefault();
      pick(visible[index]);
      return true;
    }
    return false;
  };

  return {
    active,
    onKeyDown,
    menu: active ? (
      <MentionMenu
        id={id}
        files={visible}
        activeIndex={index}
        loading={source.loading}
        error={source.error}
        query={query}
        onActiveIndexChange={setActiveIndex}
        onPick={pick}
        onRetry={source.retry}
      />
    ) : null,
    inputAttributes: active
      ? {
          "aria-autocomplete": "list" as const,
          "aria-controls": id,
          "aria-expanded": true,
          "aria-activedescendant": index >= 0 ? `${id}-option-${index}` : undefined,
        }
      : null,
  };
}
