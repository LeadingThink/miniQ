import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Folder } from "lucide-react";
import { ProjectDirectories } from "../components/ProjectDirectories";
import type { Workspace } from "../types";
import "../styles/base.css";

function Fixture() {
  const [open, setOpen] = useState(true);
  const [workspace, setWorkspace] = useState<Workspace>({
    id: "test", name: "miniQ", path: "/work/miniQ",
    additionalPaths: ["/work/shared-components", "/work/documents/research/2026/very-long-directory-name-for-mobile-layout-verification"],
    createdAt: "now", updatedAt: "now",
  });
  return <main style={{ padding: 20 }}>
    <button type="button" onClick={() => setOpen(true)}><Folder size={16} />项目目录</button>
    {open && <ProjectDirectories workspace={workspace} sessions={[]} onClose={() => setOpen(false)} onSave={async (paths) => setWorkspace({ ...workspace, path: paths[0], additionalPaths: paths.slice(1) })} />}
  </main>;
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
