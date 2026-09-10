import React from "react";
import { createRoot } from "react-dom/client";
import { QueueBar } from "../components/QueueBar";
import type { QueuedMessage } from "../types";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/interactions.css";

const initial: QueuedMessage[] = [
  {
    id: "one",
    sessionId: "fixture",
    content:
      "先检查宣传视频的字幕和配音时间轴。\n确认现场采集、数据中台与结尾品牌页衔接自然。",
    attachments: [
      { path: "/fixture/视频修改意见.pdf", name: "视频修改意见.pdf" },
    ],
    position: 1,
    createdAt: "2026-09-10",
  },
  {
    id: "two",
    sessionId: "fixture",
    content: "然后生成桌面与移动端验收报告。".repeat(24),
    position: 2,
    createdAt: "2026-09-10",
  },
];

function Fixture() {
  const [queue, setQueue] = React.useState(initial);
  const [notice, setNotice] = React.useState("");
  return (
    <main
      style={{
        maxWidth: 1000,
        margin: "auto",
        padding: 16,
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <h1>排队消息交互验收</h1>
      <p>独立样例，不连接真实会话。</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button onClick={() => setQueue(initial)}>重置队列</button>
        <button onClick={() => setQueue((items) => items.slice(1))}>
          模拟首条开始执行
        </button>
        <button
          onClick={() =>
            setQueue((items) =>
              items.map((item, index) =>
                index ? item : { ...item, content: "另一设备更新后的内容" },
              ),
            )
          }
        >
          模拟另一设备编辑
        </button>
      </div>
      <QueueBar
        queue={queue}
        onUpdate={async (original, content) => {
          setQueue((items) =>
            items.map((item) =>
              item.id === original.id
                ? { ...item, content: content.trim() }
                : item,
            ),
          );
          setNotice("已保存，附件与顺序保持不变");
        }}
        onRemove={async (id) =>
          setQueue((items) => items.filter((item) => item.id !== id))
        }
        onSteer={async (id) => {
          setQueue((items) => [
            ...items.filter((item) => item.id === id),
            ...items.filter((item) => item.id !== id),
          ]);
          setNotice("已调整方向");
        }}
      />
      <p role="status">{notice}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
