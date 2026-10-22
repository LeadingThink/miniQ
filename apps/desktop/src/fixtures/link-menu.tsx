import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Md } from "../components/Md";
import { FileContextMenu } from "../components/FileContextMenu";
import { Menu, MenuItem, MenuSeparator, MenuSubmenu } from "../components/ui/Menu";
import { ToastProvider } from "../components/ui/Toast";
import { applyTheme } from "../theme";
import "@fontsource-variable/inter/wght.css";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/themes.css";

// Visual fixture only. Native file actions still require the desktop runtime.
function Preview() {
  const [status, setStatus] = useState("右键点击正文链接，或使用下方按钮检查菜单样式。");
  const [menu, setMenu] = useState<"file" | "apps" | null>(null);
  const [dark, setDark] = useState(false);
  const file = useRef<HTMLButtonElement>(null);
  const apps = useRef<HTMLButtonElement>(null);
  return <main style={{ maxWidth: 760, margin: "48px auto", padding: 24 }}>
    <h1 style={{ fontSize: 22 }}>链接右键菜单</h1>
    <p style={{ color: "var(--text-mid)" }}>复用正式组件。浏览器预览不执行本机文件操作。</p>
    <button onClick={() => { applyTheme(dark ? "jade" : "night"); setDark(!dark); }}>切换明暗主题</button>
    <div style={{ padding: "28px 0", fontSize: 15, lineHeight: 2 }}>
      <Md workspacePath="/workspace" onOpenFile={(target) => setStatus(`预览：${target.path}`)} onOpenUrl={(url) => setStatus(`新标签页：${url}`)}>
        {"已生成 [企业半年报.pdf](/workspace/资料/企业半年报.pdf)。\n\n请查看 [申报资料](https://example.com/report)，或打开 `src/main.ts:42`。"}
      </Md>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      <button ref={file} onClick={() => setMenu("file")}>预览桌面文件菜单</button>
      <button ref={apps} onClick={() => setMenu("apps")}>预览打开方式子菜单</button>
    </div>
    <p role="status" style={{ marginTop: 32, color: "var(--text-mid)" }}>{status}</p>
    <FileContextMenu target={menu === "file" ? { path: "/workspace/资料/企业半年报.pdf", directory: false } : null}
      variant="link" anchorRef={file} onClose={() => setMenu(null)} roots={["/workspace"]} local workspacePath="/workspace"
      onOpen={(path) => setStatus(`预览：${path}`)} onError={setStatus} />
    <Menu open={menu === "apps"} anchorRef={apps} onClose={() => setMenu(null)} label="应用子菜单样式" className="link-context-menu">
      <MenuItem onClick={() => setStatus("样式预览：打开文件")}>打开文件</MenuItem>
      <MenuSubmenu label="打开方式" className="link-context-menu">
        <MenuItem onClick={() => setStatus("样式预览：默认应用")}>默认应用</MenuItem>
        <MenuItem onClick={() => setStatus("样式预览：其他已安装应用")}>其他已安装应用</MenuItem>
      </MenuSubmenu>
      <MenuSeparator />
      <MenuItem onClick={() => setStatus("样式预览：另存为")}>另存为…</MenuItem>
    </Menu>
  </main>;
}
applyTheme("jade");
createRoot(document.getElementById("root")!).render(<ToastProvider><Preview /></ToastProvider>);
