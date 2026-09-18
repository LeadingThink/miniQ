import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AtSign,
  ArrowLeft,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe2,
  Image,
  ListChecks,
  MessageSquarePlus,
  Monitor,
  Settings2,
  Share2,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { ComposerSlashCommand, ComposerSlashIcon } from "../composerSlash";
import type { LucideIcon } from "lucide-react";
import "./SlashMenu.css";

const ICONS: Record<ComposerSlashIcon, LucideIcon> = {
  new: MessageSquarePlus,
  model: Bot,
  reasoning: Brain,
  project: FolderOpen,
  skills: Sparkles,
  mcp: Wrench,
  browser: Globe2,
  computer: Monitor,
  file: FileText,
  media: Image,
  review: CheckCircle2,
  share: Share2,
  context: ListChecks,
  settings: Settings2,
  help: AtSign,
};

export function SlashMenu(props: {
  id: string;
  commands: ComposerSlashCommand[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  parent?: ComposerSlashCommand;
  onActiveIndexChange: (index: number) => void;
  onPick: (command: ComposerSlashCommand) => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({
    visibility: "hidden",
  });
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const composer = menuRef.current?.closest(".composer-card");
      if (!composer) return;
      const bounds = composer.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const above = bounds.top - top - 8;
      const below = top + height - bounds.bottom - 8;
      const placeAbove = above >= below;
      const maxHeight = Math.min(
        420,
        Math.max(100, placeAbove ? above - 8 : below - 8),
      );
      setPosition({
        left: Math.max(8, Math.min(bounds.left, width - bounds.width - 8)),
        width: Math.min(bounds.width, width - 16),
        maxHeight,
        top: placeAbove ? bounds.top - 8 : bounds.bottom + 8,
        transform: placeAbove ? "translateY(-100%)" : undefined,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, []);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [props.activeIndex, props.commands.length]);
  return (
    <div
      ref={menuRef}
      className="slash-menu"
      style={position}
      aria-label="快捷命令"
    >
      <header className="slash-header">
        {props.parent ? (
          <button
            type="button"
            className="slash-back"
            onClick={props.onBack}
            aria-label="返回全部命令"
          >
            <ArrowLeft size={14} />
            {props.parent.name}
          </button>
        ) : (
          <strong>快捷命令</strong>
        )}
        <span>{props.commands.length} 项</span>
      </header>
      <div
        className="slash-results"
        id={props.id}
        role="listbox"
        aria-label="斜杠菜单"
        aria-busy={props.loading}
      >
        {props.commands.map((command, index) => {
          const Icon = ICONS[command.icon ?? "help"];
          const groupStart =
            index === 0 || props.commands[index - 1].group !== command.group;
          return (
            <div key={command.id} role="presentation">
              {groupStart && (
                <div className="slash-title" role="presentation">
                  {command.group}
                </div>
              )}
              <button
                id={`${props.id}-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                ref={index === props.activeIndex ? activeRef : undefined}
                aria-selected={index === props.activeIndex}
                aria-disabled={Boolean(command.disabled)}
                className={`slash-item${index === props.activeIndex ? " active" : ""}`}
                onMouseEnter={() => props.onActiveIndexChange(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!command.disabled) props.onPick(command);
                }}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="slash-copy">
                  <span className="slash-name">{command.name}</span>
                  <span className="slash-desc">
                    {command.disabled
                      ? (command.disabledReason ?? command.description)
                      : command.description}
                  </span>
                </span>
                <span className="slash-meta">
                  {command.selected && (
                    <Check size={14} aria-label="当前设置" />
                  )}
                  {!props.parent && !command.id.startsWith("skill:") && (
                    <code>/{command.id}</code>
                  )}
                  {(command.children || command.loadChildren) && (
                    <ChevronRight size={14} aria-label="展开选项" />
                  )}
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {props.loading && (
        <div className="slash-state" role="status">
          正在加载{props.parent?.name ?? "技能"}…
        </div>
      )}
      {props.error && (
        <div className="slash-state error" role="alert">
          加载失败：{props.error}
          <button type="button" onClick={props.onRetry}>
            重试
          </button>
        </div>
      )}
      {!props.loading && !props.error && props.commands.length === 0 && (
        <div className="slash-state" role="status">
          没有匹配的命令，试试中文名称或英文关键词
        </div>
      )}
      <footer className="slash-footer">
        ↑↓ 选择 · Enter 确定 · Esc {props.parent ? "返回" : "关闭"}
      </footer>
    </div>
  );
}
