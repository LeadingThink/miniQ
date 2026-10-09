import { useState } from "react";
import "./ProviderOnboardingPrompt.css";

interface ProviderOnboardingPromptProps {
  onOpenSettings: () => void;
}

/** A small, dismissible reminder. Dismissal is intentionally session-scoped. */
export function ProviderOnboardingPrompt({ onOpenSettings }: ProviderOnboardingPromptProps) {
  const [deferred, setDeferred] = useState(false);

  if (deferred) {
    return <div className="provider-onboarding provider-onboarding-deferred" role="status">
      <span>模型服务尚未配置，发送前仍可恢复。</span>
      <button type="button" onClick={onOpenSettings}>配置模型服务</button>
    </div>;
  }

  return <aside className="provider-onboarding" aria-label="模型服务配置提示">
    <div><strong>先配置模型服务</strong><span>保存后返回对话，发送第一条消息验证。草稿会保留。</span></div>
    <div className="provider-onboarding-actions">
      <button type="button" className="primary" onClick={onOpenSettings}>去设置</button>
      <button type="button" onClick={() => setDeferred(true)}>稍后处理</button>
    </div>
  </aside>;
}
