import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  filterSlashCommands,
  groupSlashCommands,
  slashQuery,
  type ComposerSlashCommand,
} from "../composerSlash";
import { clampMenuIndex, moveMenuIndex } from "../menuNavigation";
import type { RpcClient } from "../rpc";
import { errorMessage } from "../errorMessage";
import { SlashMenu } from "../components/SlashMenu";
import { useSlashSkills } from "./useSlashSkills";

export function useComposerSlash(props: {
  draft: string;
  scope?: string;
  workspaceId?: string;
  client?: RpcClient;
  commands?: ComposerSlashCommand[];
  inputRef: RefObject<HTMLTextAreaElement>;
  setDraft: (value: string) => void;
  onPick: (command: ComposerSlashCommand) => Promise<void>;
}) {
  const id = useId();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const draftQuery = slashQuery(props.draft);
  const scopeKey = `${props.scope ?? ""}:${props.workspaceId ?? ""}`;
  const dismissalKey = `${scopeKey}:${props.draft}`;
  useEffect(() => {
    setDismissed(null);
  }, [scopeKey, props.draft]);
  const active = draftQuery !== null && dismissed !== dismissalKey;
  const skills = useSlashSkills(props.client, active, props.workspaceId);
  const roots = groupSlashCommands([
    ...(props.commands ?? []),
    ...skills.commands,
  ]);
  const [prefix, ...rest] = (draftQuery ?? "").split(/\s/);
  const parent =
    active && rest.length > 0
      ? roots.find(
          (command) =>
            (command.children || command.loadChildren) &&
            [command.id, command.name, ...(command.keywords ?? [])].some(
              (name) => name.toLocaleLowerCase() === prefix.toLocaleLowerCase(),
            ),
        )
      : undefined;
  const query = parent ? rest.join(" ") : (draftQuery ?? "");
  const loadKey = `${scopeKey}:${parent?.id ?? ""}`;
  const parentRef = useRef(parent);
  parentRef.current = parent;
  const [loaded, setLoaded] = useState<{
    key: string;
    commands: ComposerSlashCommand[];
    error: string | null;
    loading: boolean;
  } | null>(null);
  useEffect(() => {
    const command = parentRef.current;
    if (!active || !command?.loadChildren || command.disabled) return;
    let stale = false;
    setLoaded({ key: loadKey, commands: [], error: null, loading: true });
    void command
      .loadChildren()
      .then((commands) => {
        if (!stale)
          setLoaded({ key: loadKey, commands, error: null, loading: false });
      })
      .catch((cause) => {
        if (!stale)
          setLoaded({
            key: loadKey,
            commands: [],
            error: errorMessage(cause),
            loading: false,
          });
      });
    return () => {
      stale = true;
    };
  }, [loadKey, active, attempt, parent?.disabled]);
  const current = loaded?.key === loadKey ? loaded : null;
  const items = parent ? (parent.children ?? current?.commands ?? []) : roots;
  const visible = groupSlashCommands(filterSlashCommands(items, query)).map(
    (command) =>
      parent?.disabled
        ? { ...command, disabled: true, disabledReason: parent.disabledReason }
        : command,
  );
  const index = clampMenuIndex(activeIndex, visible.length);
  const loading =
    parent?.loadChildren && !parent.disabled
      ? (current?.loading ?? true)
      : !parent && skills.loading;
  const error = parent ? (current?.error ?? null) : skills.error;
  const itemIds = visible.map((item) => item.id).join("\n");
  useEffect(() => {
    setActiveIndex(0);
  }, [scopeKey, props.draft]);
  useEffect(() => {
    if (parent && !query) {
      const selected = visible.findIndex((item) => item.selected);
      if (selected >= 0) setActiveIndex(selected);
    }
  }, [loadKey, itemIds]);
  useEffect(() => {
    if (!active) return;
    const closeOutside = (event: PointerEvent) => {
      if (
        !props.inputRef.current
          ?.closest(".composer-card")
          ?.contains(event.target as Node)
      )
        setDismissed(dismissalKey);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [active, dismissalKey, props.inputRef]);
  const focus = () =>
    requestAnimationFrame(() => props.inputRef.current?.focus());
  const back = () => {
    props.setDraft("/");
    focus();
  };
  const pick = async (command: ComposerSlashCommand) => {
    if (command.disabled || pendingRef.current) return;
    if (command.children || command.loadChildren) {
      props.setDraft(`/${command.id} `);
      focus();
      return;
    }
    pendingRef.current = true;
    setPending(true);
    try {
      await props.onPick(command);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      !active ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return false;
    if (event.key === "Escape") {
      event.preventDefault();
      if (parent) back();
      else setDismissed(dismissalKey);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        moveMenuIndex(
          index,
          visible.length,
          event.key === "ArrowDown" ? 1 : -1,
        ),
      );
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      event.preventDefault();
      if (index >= 0 && visible[index]) void pick(visible[index]);
      return true;
    }
    return false;
  };
  return {
    pending,
    onKeyDown,
    menu: active ? (
      <SlashMenu
        id={id}
        commands={visible}
        activeIndex={index}
        parent={parent}
        loading={Boolean(loading)}
        error={error}
        onActiveIndexChange={setActiveIndex}
        onPick={(command) => void pick(command)}
        onBack={back}
        onRetry={() =>
          parent ? setAttempt((value) => value + 1) : skills.retry()
        }
      />
    ) : null,
    inputAttributes: {
      "aria-autocomplete": active ? ("list" as const) : undefined,
      "aria-controls": active ? id : undefined,
      "aria-expanded": active,
      "aria-activedescendant":
        active && index >= 0 ? `${id}-option-${index}` : undefined,
    },
  };
}
