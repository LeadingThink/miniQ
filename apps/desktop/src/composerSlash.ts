export type ComposerSlashIcon =
  | "new"
  | "model"
  | "reasoning"
  | "project"
  | "skills"
  | "mcp"
  | "browser"
  | "computer"
  | "file"
  | "media"
  | "review"
  | "share"
  | "context"
  | "settings"
  | "help";

export interface ComposerSlashCommand {
  id: string;
  name: string;
  description: string;
  group: string;
  keywords?: string[];
  icon?: ComposerSlashIcon;
  insertText?: string;
  onSelect?: () => void | Promise<void>;
  children?: ComposerSlashCommand[];
  loadChildren?: () => Promise<ComposerSlashCommand[]>;
  disabled?: boolean;
  disabledReason?: string;
  selected?: boolean;
}

/** A standalone slash query, never a URL, absolute path or multiline message. */
export function slashQuery(draft: string): string | null {
  return /^\/[^/\n\r]*$/.test(draft) ? draft.slice(1) : null;
}

export function filterSlashCommands(
  commands: ComposerSlashCommand[],
  query: string,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => {
    const text = [
      command.id,
      command.name,
      command.description,
      command.group,
      ...(command.keywords ?? []),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** Keep groups contiguous without dropping lower-ranked results. */
export function groupSlashCommands(commands: ComposerSlashCommand[]) {
  const groups = new Map<string, ComposerSlashCommand[]>();
  for (const command of commands) {
    const group = groups.get(command.group) ?? [];
    group.push(command);
    groups.set(command.group, group);
  }
  return [...groups.values()].flat();
}
