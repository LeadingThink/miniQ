import type { Session, Workspace } from "../types";

export function Sidebar(props: {
  workspaces: Workspace[];
  sessions: Session[];
  currentSessionId: string | null;
  onOpenWorkspace: () => void;
  onCreateSession: (workspaceId: string) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  return (
    <div className="sidebar">
      <div className="brand">miniQ</div>
      <button onClick={props.onOpenWorkspace}>Open workspace</button>

      {props.workspaces.map((ws) => (
        <div key={ws.id}>
          <h2 title={ws.path}>{ws.name}</h2>
          <button className="secondary" onClick={() => props.onCreateSession(ws.id)}>
            + New session
          </button>
          {props.sessions
            .filter((s) => s.workspaceId === ws.id)
            .map((s) => (
              <div
                key={s.id}
                className={`list-item ${s.id === props.currentSessionId ? "active" : ""}`}
                onClick={() => props.onSelectSession(s.id)}
              >
                {s.title}
                <div className="sub">
                  {s.status} · {new Date(s.updatedAt).toLocaleString()}
                </div>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
