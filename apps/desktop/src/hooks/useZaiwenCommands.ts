import { useEffect, useState } from "react";
import type { MiniqAppController } from "./useMiniqApp";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { COMMAND_EVENT, type CommandEventDetail } from "../shortcuts";
import { dispatchSessionToolbarAction } from "../components/TimelineToolbar";

/** Keep native menu and keyboard navigation available while the local workbench is suspended. */
export function useZaiwenCommands(app: MiniqAppController, onNavigate: () => void, onStop: () => void, sessionId: string) {
  const [showShortcuts, setShowShortcuts] = useState(false);
  const run = (id: string) => {
    switch (id) {
      case "newChat": onNavigate(); app.actions.newChat(); return true;
      case "settings": onNavigate(); app.navigation.setShowSettings(true); return true;
      case "palette": onNavigate(); app.navigation.setShowSearch(true); return true;
      case "toggleSidebar": app.navigation.setSidebarCollapsed(!app.navigation.sidebarCollapsed); return true;
      case "stop": onStop(); return true;
      case "showShortcuts": setShowShortcuts((value) => !value); return true;
      case "find": dispatchSessionToolbarAction(sessionId, "search"); return true;
      default: return false;
    }
  };
  useGlobalShortcuts({ onNewChat: () => run("newChat"), onSettings: () => run("settings"), onPalette: () => run("palette"),
    onToggleSidebar: () => run("toggleSidebar"), onStop, onShortcut: (match) => run(match.id),
    onSessionSearch: () => { run("find"); } });
  useEffect(() => {
    const listener = (event: Event) => run((event as CustomEvent<CommandEventDetail>).detail?.id);
    window.addEventListener(COMMAND_EVENT, listener);
    return () => window.removeEventListener(COMMAND_EVENT, listener);
  });
  return { showShortcuts, closeShortcuts: () => setShowShortcuts(false) };
}
