import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RotateCcw } from "lucide-react";
import { QuestionCard } from "../components/QuestionCard";
import type { Question } from "../types";
import "../styles/base.css";
import "../styles/conversation.css";
import "../styles/interactions.css";

const question: Question = {
  id: "video-materials",
  sessionId: "fixture",
  toolCallId: "fixture",
  header: "视频素材",
  prompt: "**现场采集 / 数据中台视频素材怎么处理？**\n\n工作区里准备优先使用：\n\n1. `EgoBand实拍_实时3D手部重建.mp4`：现场、近场采集。\n2. `RoboRDA_遥操作演示.mp4` 或 `真实任务手物交互.mov`：现场任务。\n3. `多模态数据样例_可视化界面.mp4` / `hub_demo.mp4`：数据中台处理。\n\n有更新素材可以补充路径；没有则使用现有素材制作完整增强版。",
  options: ["用现有最佳素材直接做完整增强版", "我马上补充更新视频路径", "现场用现有，中台视频另给"],
  optionDescriptions: {
    "用现有最佳素材直接做完整增强版": "使用上述采集与处理视频，完成后可替换素材。",
    "我马上补充更新视频路径": "使用补充回答中的文件路径。",
    "现场用现有，中台视频另给": "保留现场采集素材，仅替换数据中台视频。",
  },
  createdAt: new Date().toISOString(),
};

function Fixture() {
  const [key, setKey] = useState(0);
  const [multiSelect, setMultiSelect] = useState(false);
  const [freeText, setFreeText] = useState(false);
  const [fail, setFail] = useState(false);
  const [answer, setAnswer] = useState("");
  return <main style={{ width: "min(780px, 100%)", margin: "24px auto", padding: 12 }}>
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 16 }}>
      <label><input type="checkbox" checked={multiSelect} onChange={(event) => { setMultiSelect(event.target.checked); setKey(key + 1); }} />多选</label>
      <label><input type="checkbox" checked={freeText} onChange={(event) => { setFreeText(event.target.checked); setKey(key + 1); }} />自由回答</label>
      <label><input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} />模拟断网</label>
      <button type="button" onClick={() => { setKey(key + 1); setAnswer(""); }}><RotateCcw size={14} />重置</button>
    </div>
    <QuestionCard key={key} question={{ ...question, multiSelect, options: freeText ? [] : question.options }} onResolve={async (_id, value) => {
      if (fail) throw new Error("连接断开，请重新发送");
      setAnswer(value);
    }} onOpenFile={(target) => setAnswer(target.path)} />
    {answer && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{answer}</pre>}
  </main>;
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
