import { FileSearch, Globe, GitCompare, SquareTerminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import "./WorkbenchLauncher.css";

const MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export interface WorkbenchLauncherActions {
  /** Opens the project file tree with its filter focused (⌘P). */
  onOpenFiles?: () => void;
  onOpenBrowser?: () => void;
  browserLabel?: string;
  onOpenReview?: () => void;
  changes?: number;
  /** Opens the system terminal in the workspace directory. */
  onOpenTerminal?: () => void;
}

interface Entry {
  key: string;
  label: string;
  hint?: string;
  Icon: LucideIcon;
  run: () => void;
}

/** Entry points shown when the side panel has nothing open, like ChatGPT. */
export function WorkbenchLauncher({
  actions,
  compact = false,
}: {
  actions: WorkbenchLauncherActions;
  compact?: boolean;
}) {
  const entries: Entry[] = [];
  if (actions.onOpenFiles)
    entries.push({
      key: "files",
      label: "文件",
      hint: MAC ? "⌘P" : "Ctrl+P",
      Icon: FileSearch,
      run: actions.onOpenFiles,
    });
  if (actions.onOpenBrowser)
    entries.push({
      key: "browser",
      label: actions.browserLabel ?? "浏览器",
      Icon: Globe,
      run: actions.onOpenBrowser,
    });
  if (actions.onOpenReview)
    entries.push({
      key: "review",
      label: "审阅修改",
      hint: actions.changes ? `${actions.changes} 个文件` : undefined,
      Icon: GitCompare,
      run: actions.onOpenReview,
    });
  if (actions.onOpenTerminal)
    entries.push({
      key: "terminal",
      label: "终端",
      Icon: SquareTerminal,
      run: actions.onOpenTerminal,
    });
  if (!entries.length) return null;
  return (
    <nav
      className={`workbench-launcher${compact ? " compact" : ""}`}
      aria-label="打开工作面板"
    >
      {entries.map(({ key, label, hint, Icon, run }) => (
        <button
          key={key}
          type="button"
          className="workbench-launcher-entry"
          data-entry={key}
          onClick={run}
        >
          <Icon size={compact ? 15 : 17} aria-hidden />
          <span>{label}</span>
          {hint && <kbd>{hint}</kbd>}
        </button>
      ))}
    </nav>
  );
}
