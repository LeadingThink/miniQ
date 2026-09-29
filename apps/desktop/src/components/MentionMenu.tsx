import { useEffect, useRef } from "react";
import { FileText, Folder } from "lucide-react";
import type { MentionFile } from "../composerMention";
import { useComposerPopoverPosition } from "../hooks/useComposerPopoverPosition";
import "./SlashMenu.css";

function split(path: string): { name: string; dir: string } {
  const trimmed = path.replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  return { name: trimmed.slice(slash + 1), dir: slash >= 0 ? trimmed.slice(0, slash) : "" };
}

/** File candidates for `@` mentions; shares the slash menu's look and keys. */
export function MentionMenu(props: {
  id: string;
  files: MentionFile[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  query: string;
  onActiveIndexChange: (index: number) => void;
  onPick: (file: MentionFile) => void;
  onRetry: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const position = useComposerPopoverPosition(menuRef);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [props.activeIndex, props.files.length]);
  return (
    <div ref={menuRef} className="slash-menu mention-menu" style={position} aria-label="引用文件">
      <header className="slash-header">
        <strong>引用文件</strong>
        <span>{props.files.length} 项</span>
      </header>
      <div className="slash-results" id={props.id} role="listbox" aria-label="文件候选" aria-busy={props.loading}>
        {props.files.map((file, index) => {
          const { name, dir } = split(file.path);
          const Icon = file.directory ? Folder : FileText;
          return (
            <button
              key={file.path}
              id={`${props.id}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              ref={index === props.activeIndex ? activeRef : undefined}
              aria-selected={index === props.activeIndex}
              className={`slash-item${index === props.activeIndex ? " active" : ""}`}
              title={file.path}
              onMouseEnter={() => props.onActiveIndexChange(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onPick(file)}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="slash-copy">
                <span className="slash-name">{name}{file.directory ? "/" : ""}</span>
                {dir && <span className="slash-desc">{dir}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {props.loading && props.files.length === 0 && (
        <div className="slash-state" role="status">正在读取项目文件…</div>
      )}
      {props.error && (
        <div className="slash-state error" role="alert">
          读取失败：{props.error}
          <button type="button" onClick={props.onRetry}>重试</button>
        </div>
      )}
      {!props.loading && !props.error && props.files.length === 0 && (
        <div className="slash-state" role="status">
          {props.query ? "没有匹配的文件" : "项目中没有可引用的文件"}
        </div>
      )}
      <footer className="slash-footer">↑↓ 选择 · Enter 或 Tab 插入 · Esc 关闭</footer>
    </div>
  );
}
