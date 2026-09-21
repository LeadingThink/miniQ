import { Brain, Monitor, Palette, Server } from "lucide-react";

const tabs = [
  { id: "services", label: "服务与远程", icon: Server },
  { id: "computer", label: "电脑控制", icon: Monitor },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "memory", label: "记忆", icon: Brain },
] as const;

export type SettingsTab = (typeof tabs)[number]["id"];

export function SettingsTabs({ selected, onSelect }: {
  selected: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
}) {
  return <div className="settings-tabs" role="tablist" aria-label="设置分类">
    {tabs.map(({ id, label, icon: Icon }, index) => <button
      key={id}
      type="button"
      role="tab"
      id={`settings-tab-${id}`}
      aria-controls={`settings-${id}`}
      aria-selected={selected === id}
      tabIndex={selected === id ? 0 : -1}
      onClick={() => onSelect(id)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
          : (index + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
        const next = tabs[nextIndex].id;
        onSelect(next);
        document.getElementById(`settings-tab-${next}`)?.focus();
      }}
    ><Icon size={15} />{label}</button>)}
  </div>;
}
