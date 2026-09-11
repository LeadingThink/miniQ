import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerCard } from "../components/Composer";
import { RpcClient, type LocalConnectionInfo } from "../rpc";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";

// Development-only acceptance page. Supply a dedicated daemon connection in
// sessionStorage; this fixture never discovers the user's running daemon.
function Fixture() {
  const [client, setClient] = useState<RpcClient>();
  const [session, setSession] = useState("voice-fixture-a");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const connection = sessionStorage.getItem("voice-fixture-connection");
    if (!connection) { setNotice("请配置独立验收 daemon 的连接"); return; }
    const rpc = new RpcClient();
    let disposed = false;
    void rpc.connect(JSON.parse(connection) as LocalConnectionInfo).then(() => {
      if (!disposed) setClient(rpc);
    }).catch(error => { if (!disposed) setNotice(String(error)); });
    return () => { disposed = true; };
  }, []);
  return <main style={{ maxWidth: 800, margin: "40px auto", padding: 16 }}>
    <h1>语音输入验收</h1>
    <p>录音中逐步显示，结束后校正并填入草稿。</p>
    <button onClick={() => setSession(session === "voice-fixture-a" ? "voice-fixture-b" : "voice-fixture-a")}>切换验收会话</button>
    <button onClick={() => {
      const start = performance.now();
      void client?.call("daemon.health").then(() => setNotice(`连接正常：${Math.round(performance.now() - start)} ms`));
    }}>检查连接</button>
    {client && <ComposerCard busy={false} placeholder="可先输入草稿，再开始说话" draftKey={session}
      client={client} onSend={async () => { setNotice("草稿验收完成，未发送到真实会话"); return false; }} onError={setNotice} />}
    <p role="status">{notice}</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
