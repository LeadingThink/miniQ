import { Trash2 } from "lucide-react";
import { memo, useState } from "react";
import { mobileMessageText, type MobileChatMessage } from "../mobileChatData";
import { CopyButton } from "./CopyButton";
import { Md } from "./Md";

export const MobileChatRow = memo(function MobileChatRow(props: {
  message: MobileChatMessage;
  active: boolean;
  onDelete: (id: string) => void;
}) {
  const { message, active, onDelete } = props;
  const [confirming, setConfirming] = useState(false);
  const text = mobileMessageText(message.content);

  return <article className={`mobile-chat-message ${message.role}`}>
    <div className="mobile-chat-message-content">
      {message.role === "assistant" ? <Md>{text || (active ? "正在思考…" : "")}</Md>
        : typeof message.content === "string" ? message.content
          : message.content.map((part, index) => part.type === "text" ? <span key={index}>{part.text}</span>
            : <img key={index} src={part.image_url.url} alt="已附加图片" loading="lazy" />)}
    </div>
    {!active && message.status && <div className="mobile-chat-status">{message.status === "interrupted" ? "已停止，收到的内容已保留" : "回答未完成，收到的内容已保留"}</div>}
    <div className="mobile-chat-message-actions" role="group" aria-label="消息操作">
      <CopyButton content={text} label="复制" className="mobile-chat-message-action" showLabel disabled={!text} />
      <button type="button" className="mobile-chat-message-action" onClick={() => setConfirming(true)} aria-expanded={confirming}>
        <Trash2 size={14} /><span>删除</span>
      </button>
    </div>
    {confirming && <div className="mobile-chat-delete-confirm" role="group" aria-label="确认删除这条消息">
      <p>{active ? "删除这条回答并停止生成？" : "删除这条消息？"}删除后，后续问答将不再使用它。</p>
      <button type="button" onClick={() => setConfirming(false)}>取消</button>
      <button type="button" className="danger" onClick={() => onDelete(message.id)}>确认删除</button>
    </div>}
  </article>;
});
