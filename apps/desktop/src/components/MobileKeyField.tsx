import { ExternalLink, Eye, EyeOff } from "lucide-react";
import { useId, useState, type RefObject } from "react";

export function MobileKeyField(props: {
  inputRef: RefObject<HTMLInputElement>;
  value: string;
  disabled: boolean;
  native: boolean;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return <div className="mobile-entry-field">
    <label htmlFor={id}>在问 API Key</label>
    <div className="mobile-entry-key-control">
      <input id={id} ref={props.inputRef} type={visible ? "text" : "password"} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        enterKeyHint="go" value={props.value} placeholder="sk-..." disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)} />
      <button type="button" className="secondary" disabled={props.disabled} aria-label={visible ? "隐藏 API Key" : "显示 API Key"} aria-pressed={visible} onClick={() => setVisible((value) => !value)}>
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
    <small>{props.native ? "Key 保存在系统安全存储中，下次打开应用无需重新输入；relay 不接收 Key 原文。" : "relay 不接收 Key 原文。"}</small>
    <a className="mobile-entry-get-key" href="https://platform.zaiwenai.com/" target="_blank" rel="noreferrer">还没有 Key？前往在问获取<ExternalLink size={13} /></a>
  </div>;
}
