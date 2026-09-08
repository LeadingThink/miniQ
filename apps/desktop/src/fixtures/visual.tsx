import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ComputerObservation } from "../components/ComputerObservation";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import "../styles/base.css";
import "../styles/themes.css";

// Local bitmap fixtures only. This page never connects to a real daemon or provider.
function bitmap(page: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 640; canvas.height = 800;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 640, 800);
  ctx.fillStyle = "#272b32"; ctx.font = "bold 30px sans-serif";
  ctx.fillText(`miniQ / ${page === 0 ? "Page 2" : "Page 5"}`, 48, 75);
  ctx.font = "20px sans-serif"; ctx.fillText("Visual evidence fixture", 48, 118);
  for (let index = 0; index < 4; index++) {
    ctx.fillStyle = ["#167d73", "#e25884", "#4b76d0", "#737a84"][index];
    ctx.fillRect(48, 175 + index * 105, 130 + ((index + page) % 4) * 88, 60);
  }
  const base64 = canvas.toDataURL("image/png").split(",")[1];
  return { base64, bytes: atob(base64).length };
}
const images = [bitmap(0), bitmap(1)];
const call: ToolCall = {
  id: "visual-fixture", sessionId: "isolated", toolName: "view_pdf", input: {path:"fixture.pdf",pages:"2,5"},
  status:"succeeded",createdAt:"2026-09-08T00:00:00Z",
  output:{pages:images.map((image, index) => ({page:index === 0 ? 2 : 5,screenshot:{id:`${index === 0 ? "aa" : "bb"}8091e1-3bf0-4b0f-b699-260f2ac9e081`,width:640,height:800,bytes:image.bytes}}))},
};
const client = {call: async (_method: string, params: {imageIndex: number}) => {
  const image = images[params.imageIndex];
  return {offset:0,nextOffset:image.bytes,totalBytes:image.bytes,done:true,mimeType:"image/png",base64:image.base64};
}} as unknown as RpcClient;

function Fixture() {
  const [mobile, setMobile] = useState(false);
  return <main style={{maxWidth:mobile ? 360 : 880, width:"100%",margin:"0 auto",padding:12,boxSizing:"border-box"}}>
    <header style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
      <strong>miniQ</strong><label><input type="checkbox" checked={mobile} onChange={event => setMobile(event.target.checked)} /> 手机宽度</label>
    </header>
    <ComputerObservation call={call} client={client} />
  </main>;
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
