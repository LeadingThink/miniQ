import { Eye, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "./CopyButton";

export function ProviderKeyField({ value, disabled = false, loading = false, onChange }: {
  value: string;
  disabled?: boolean;
  loading?: boolean;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const inputDisabled = disabled || loading;
  return (
    <label htmlFor="provider-api-key" className="provider-key-field">
      <span className="provider-key-label"><KeyRound size={14} />在问 API Key</span>
      <span className="provider-key-input-wrap">
        <input id="provider-api-key" type={visible ? "text" : "password"} autoComplete="off" spellCheck={false}
          value={value} disabled={inputDisabled} placeholder={loading ? "正在读取已保存的 Key…" : "sk-..."}
          onChange={(event) => onChange(event.target.value)} />
        <span className="provider-key-actions">
          <button type="button" className="icon-button provider-key-action"
            title={visible ? "隐藏 API Key" : "显示 API Key"}
            aria-label={visible ? "隐藏 API Key" : "显示 API Key"}
            disabled={inputDisabled || !value} onClick={() => setVisible((current) => !current)}>
            {visible ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <CopyButton content={value} label="复制 API Key" className="icon-button provider-key-action"
            disabled={inputDisabled || !value} />
        </span>
      </span>
    </label>
  );
}
