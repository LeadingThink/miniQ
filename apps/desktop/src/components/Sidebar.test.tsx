import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Session, Workspace } from "../types";
import { Sidebar } from "./Sidebar";

const noop = () => undefined;
const workspace: Workspace = {
  id: "workspace-1",
  name: "miniQ",
  path: "/work/miniq",
  createdAt: "2026-09-03T00:00:00Z",
  updatedAt: "2026-09-03T00:00:00Z",
};
const session: Session = {
  id: "session-1",
  workspaceId: workspace.id,
  title: "完善预览",
  status: "running",
  pinned: false,
  archived: false,
  createdAt: "2026-09-03T00:00:00Z",
  updatedAt: "2026-09-03T00:00:00Z",
};

describe("Sidebar", () => {
  it("uses keyboard-operable controls for projects and sessions", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        workspaces={[workspace]}
        sessions={[session]}
        currentSessionId={session.id}
        selectedWorkspaceId={workspace.id}
        onNewChat={noop}
        onShowSearch={noop}
        onShowSchedule={noop}
        onImportSessions={noop}
        onSelectWorkspace={noop}
        onCreateSession={noop}
        onDeleteWorkspace={noop}
        onRenameWorkspace={noop}
        onSelectSession={noop}
        onDeleteSession={noop}
        onRenameSession={noop}
        onSetSessionPinned={noop}
        onSetSessionArchived={noop}
        onShowSkills={noop}
        onShowMcp={noop}
        onShowSettings={noop}
        updateSupported={false}
        updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null }}
        onCheckForUpdates={noop}
        onInstallUpdate={noop}
        onError={noop}
      />,
    );
    expect(html).toContain('class="workspace-select"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('class="session-select"');
    expect(html).toContain('aria-current="page"');
  });
});
