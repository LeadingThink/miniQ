import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  AtSign,
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
  type LucideIcon,
} from "lucide-react";
import { useComposerPopoverPosition } from "../hooks/useComposerPopoverPosition";
import type { ComposerSlashCommand, ComposerSlashIcon } from "../composerSlash";
import { VirtualList, type VirtualListHandle } from "./ui/VirtualList";
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

interface Props {
  inputRef: RefObject<HTMLElement | null>;
  id: string;
  commands: ComposerSlashCommand[];
  activeIndex: number;
  navigationKey?: string;
  loading: boolean;
  error: string | null;
  parent?: ComposerSlashCommand;
  onActiveIndexChange: (index: number) => void;
  onPick: (command: ComposerSlashCommand) => void;
  onBack: () => void;
  onRetry: () => void;
}

function SlashOption({
  command,
  index,
  props,
}: {
  command: ComposerSlashCommand;
  index: number;
  props: Props;
}) {
  const Icon = ICONS[command.icon ?? "help"];
  return (
    <button
      id={`${props.id}-option-${index}`}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={index === props.activeIndex}
      aria-disabled={Boolean(command.disabled)}
      aria-setsize={props.commands.length}
      aria-posinset={index + 1}
      className={`slash-item${index === props.activeIndex ? " active" : ""}`}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse" && index !== props.activeIndex)
          props.onActiveIndexChange(index);
      }}
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
        {command.selected && <Check size={14} aria-label="当前设置" />}
        {!props.parent && !command.id.startsWith("skill:") && (
          <code>/{command.id}</code>
        )}
        {(command.children || command.loadChildren) && (
          <ChevronRight size={14} aria-label="展开选项" />
        )}
      </span>
    </button>
  );
}

export function SlashMenu(props: Props) {
  const position = useComposerPopoverPosition(props.inputRef);
  const resultsRef = useRef<HTMLDivElement>(null);
  const handle = useRef<VirtualListHandle>(null);
  const pointerIndex = useRef<number | null>(null);
  const activeKey = props.commands[props.activeIndex]?.id;
  useLayoutEffect(() => {
    if (pointerIndex.current !== props.activeIndex)
      handle.current?.scrollToIndex(props.activeIndex);
    pointerIndex.current = null;
  }, [props.activeIndex, activeKey, props.navigationKey]);
  const onActiveIndexChange = (index: number) => {
    pointerIndex.current = index;
    props.onActiveIndexChange(index);
  };
  return createPortal(
    <div className="slash-menu" style={position} aria-label="快捷命令">
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
        ref={resultsRef}
        className="slash-results"
        id={props.id}
        role="listbox"
        aria-label="斜杠菜单"
        aria-busy={props.loading}
      >
        <VirtualList
          count={props.commands.length}
          getKey={(index) => props.commands[index].id}
          estimateSize={(index) =>
            index === 0 ||
            props.commands[index - 1].group !== props.commands[index].group
              ? 104
              : 76
          }
          scrollRef={resultsRef}
          handle={handle}
          keepMounted={[props.activeIndex]}
        >
          {(index) => {
            const command = props.commands[index];
            const groupStart =
              index === 0 || props.commands[index - 1].group !== command.group;
            return (
              <div role="presentation">
                {groupStart && (
                  <div className="slash-title" role="presentation">
                    {command.group}
                  </div>
                )}
                <SlashOption
                  command={command}
                  index={index}
                  props={{ ...props, onActiveIndexChange }}
                />
              </div>
            );
          }}
        </VirtualList>
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
    </div>,
    document.body,
  );
}
