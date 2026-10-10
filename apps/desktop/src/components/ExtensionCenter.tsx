import { ArrowLeft, Blocks, PlugZap, Sparkles } from "lucide-react";
import type { RpcClient } from "../rpc";
import { SkillsPanel } from "./Skills";
import { McpPanel } from "./Mcp";
import { PluginsPanel } from "./Plugins";
import "./ExtensionCenter.css";

export type ExtensionSection = "skills" | "mcp" | "plugins";
const sections = [
  { id: "skills", label: "技能", icon: Sparkles },
  { id: "mcp", label: "连接器", icon: PlugZap },
  { id: "plugins", label: "扩展包", icon: Blocks },
] as const;

export function ExtensionCenter({
  client,
  workspaceId,
  selected,
  onSelect,
  onClose,
}: {
  client: RpcClient;
  workspaceId: string | null;
  selected: ExtensionSection;
  onSelect: (section: ExtensionSection) => void;
  onClose: () => void;
}) {
  return (
    <section className="extension-center" aria-label="技能与连接器">
      <div className="extension-center-toolbar">
        <button
          type="button"
          className="ghost extension-back"
          onClick={onClose}
          aria-label="返回对话"
          title="返回对话"
        >
          <ArrowLeft size={17} /> <span>返回对话</span>
        </button>
        <nav className="extension-tabs" aria-label="能力分类" role="tablist">
          {sections.map(({ id, label, icon: Icon }, index) => (
            <button
              type="button"
              role="tab"
              key={id}
              id={`extension-tab-${id}`}
              aria-controls="extension-content"
              aria-selected={selected === id}
              tabIndex={selected === id ? 0 : -1}
              onClick={() => onSelect(id)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? sections.length - 1
                      : (index +
                          (event.key === "ArrowLeft" ? -1 : 1) +
                          sections.length) %
                        sections.length;
                onSelect(sections[next].id);
                document
                  .getElementById(`extension-tab-${sections[next].id}`)
                  ?.focus();
              }}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <span className="extension-center-caption">工作流 · 应用 · 服务</span>
      </div>
      <div
        className="extension-content"
        id="extension-content"
        role="tabpanel"
        aria-labelledby={`extension-tab-${selected}`}
      >
        {selected === "skills" && (
          <SkillsPanel client={client} workspaceId={workspaceId} />
        )}
        {selected === "mcp" && (
          <McpPanel
            client={client}
            onManagePlugins={() => onSelect("plugins")}
          />
        )}
        {selected === "plugins" && <PluginsPanel client={client} />}
      </div>
    </section>
  );
}
