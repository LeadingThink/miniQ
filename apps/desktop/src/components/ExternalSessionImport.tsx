import { useEffect } from "react";
import {
  Check,
  Download,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { RpcClient } from "../rpc";
import {
  type ExternalSessionImportState,
  useExternalSessionImport,
} from "../hooks/useExternalSessionImport";
import { localDateTime } from "../time";
import type {
  ExternalProvider,
  ExternalSessionImportResult,
  ExternalSessionScan,
  Workspace,
} from "../types";
import {
  EXTERNAL_PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_MARKS,
  externalSessionKey,
} from "./externalSessionImportModel";

interface ExternalSessionImportProps {
  client: RpcClient;
  workspaces: Workspace[];
  onClose: () => void;
  onImported: () => Promise<void>;
  onOpenSession: (sessionId: string) => Promise<void>;
}

export function ExternalSessionImportDialog(props: ExternalSessionImportProps) {
  const state = useExternalSessionImport({
    client: props.client,
    onImported: props.onImported,
  });

  const openFirstImported = async () => {
    const sessionId = state.result?.importedSessionIds[0];
    if (!sessionId) return;
    props.onClose();
    await props.onOpenSession(sessionId);
  };
  const close = () => {
    if (!state.importing) props.onClose();
  };
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !state.importing) props.onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [props.onClose, state.importing]);

  return (
    <div className="external-import-overlay" role="presentation" onMouseDown={close}>
      <section
        aria-busy={state.loading || state.importing}
        aria-labelledby="external-import-title"
        aria-modal="true"
        className="external-import-dialog"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="external-import-header">
          <div>
            <h2 id="external-import-title">导入会话</h2>
            <ProviderStatus scan={state.scan} />
          </div>
          <button
            className="external-icon-button"
            disabled={state.importing}
            onClick={close}
            title="关闭"
          >
            <X size={17} />
          </button>
        </header>

        {state.result ? (
          <ImportResult result={state.result} />
        ) : (
          <>
            <ImportToolbar
              providers={state.providers}
              search={state.search}
              workspaceId={state.workspaceId}
              workspaces={props.workspaces}
              loading={state.loading}
              onProvidersChange={state.setProviders}
              onSearchChange={state.setSearch}
              onWorkspaceChange={state.setWorkspaceId}
              onRefresh={() => void state.runScan()}
            />
            <SessionList
              state={state}
            />
          </>
        )}

        {state.error && <div className="external-import-error" role="alert">{state.error}</div>}
        <ImportFooter
          state={state}
          onClose={close}
          onOpenFirstImported={openFirstImported}
        />
      </section>
    </div>
  );
}

function ImportFooter(props: {
  state: ExternalSessionImportState;
  onClose: () => void;
  onOpenFirstImported: () => Promise<void>;
}) {
  const { state } = props;
  return (
    <footer className="external-import-footer">
      <span>
        {state.result
          ? `${state.result.importedMessages} 条新消息`
          : `${state.selected.size} 个会话`}
      </span>
      <div>
        <button className="ghost" disabled={state.importing} onClick={props.onClose}>
          {state.result ? "完成" : "取消"}
        </button>
        {state.result ? (
          <button
            className="primary"
            disabled={state.result.importedSessionIds.length === 0}
            onClick={() => void props.onOpenFirstImported()}
          >
            <Check size={15} /> 打开会话
          </button>
        ) : (
          <button
            className="primary"
            disabled={state.selected.size === 0 || state.loading || state.importing}
            onClick={() => void state.importSelected()}
          >
            {state.importing ? (
              <LoaderCircle className="external-spin" size={15} />
            ) : (
              <Download size={15} />
            )}
            导入
          </button>
        )}
      </div>
    </footer>
  );
}

function ProviderStatus({ scan }: { scan: ExternalSessionScan | null }) {
  if (!scan) return <p className="external-import-subtitle">正在扫描</p>;
  const available = scan.providers.filter((provider) => provider.available);
  const count = scan.sessions.length;
  return (
    <p className="external-import-subtitle">
      {available.map((provider) => PROVIDER_LABELS[provider.provider]).join(" · ") || "未检测到来源"}
      {count > 0 ? ` · ${count} 个会话` : ""}
    </p>
  );
}

interface ImportToolbarProps {
  providers: Set<ExternalProvider>;
  search: string;
  workspaceId: string;
  workspaces: Workspace[];
  loading: boolean;
  onProvidersChange: (value: Set<ExternalProvider>) => void;
  onSearchChange: (value: string) => void;
  onWorkspaceChange: (value: string) => void;
  onRefresh: () => void;
}

function ImportToolbar(props: ImportToolbarProps) {
  const toggleProvider = (provider: ExternalProvider) => {
    const next = new Set(props.providers);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    props.onProvidersChange(next);
  };
  return (
    <div className="external-import-toolbar">
      <div className="external-provider-segments" aria-label="会话来源">
        {EXTERNAL_PROVIDERS.map((provider) => (
          <button
            className={props.providers.has(provider) ? "active" : ""}
            key={provider}
            onClick={() => toggleProvider(provider)}
          >
            <ProviderMark provider={provider} /> {PROVIDER_LABELS[provider]}
          </button>
        ))}
      </div>
      <div className="external-import-controls">
        <label className="external-search">
          <Search size={15} />
          <input
            aria-label="搜索会话"
            placeholder="搜索"
            value={props.search}
            onChange={(event) => props.onSearchChange(event.target.value)}
          />
        </label>
        <select
          aria-label="目标项目"
          value={props.workspaceId}
          onChange={(event) => props.onWorkspaceChange(event.target.value)}
        >
          <option value="">原项目目录</option>
          {props.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
        <button
          className="external-icon-button"
          disabled={props.loading}
          onClick={props.onRefresh}
          title="重新扫描"
        >
          <RefreshCw size={16} />
        </button>
      </div>
    </div>
  );
}

function SessionList({ state }: { state: ExternalSessionImportState }) {
  if (state.loading) {
    return <div className="external-import-empty"><LoaderCircle className="external-spin" size={22} />扫描中</div>;
  }
  if (!state.scan || state.visible.length === 0) {
    return (
      <div className="external-session-list">
        <div className="external-import-empty">未发现会话</div>
        <ScanWarnings state={state} />
      </div>
    );
  }
  return (
    <div className="external-session-list">
      <label className="external-session-select-all">
        <input
          checked={state.allVisibleSelected}
          type="checkbox"
          onChange={(event) => state.toggleAll(event.target.checked)}
        />
        <span>全选</span>
      </label>
      {state.visible.map((session) => {
        const key = externalSessionKey(session);
        return (
          <label className="external-session-row" key={key} title={session.sourcePath}>
            <input
              checked={state.selected.has(key)}
              type="checkbox"
              onChange={(event) =>
                state.toggleOne(key, event.target.checked)
              }
            />
            <ProviderMark provider={session.provider} />
            <span className="external-session-main">
              <strong title={session.title}>{session.title}</strong>
              <small title={session.cwd ?? session.sourcePath}>
                {session.cwd ?? "未绑定项目"} · {session.messageCount} 条消息
              </small>
            </span>
            <time>{session.updatedAt ? localDateTime(session.updatedAt) : ""}</time>
          </label>
        );
      })}
      <ScanWarnings state={state} />
    </div>
  );
}

function ScanWarnings({ state }: { state: ExternalSessionImportState }) {
  return (
    <>
      {(state.scan?.errors ?? []).map((item, index) => (
        <div className="external-scan-warning" key={`${item.provider}-${item.sourcePath}-${index}`}>
          {PROVIDER_LABELS[item.provider]}: {item.message}
        </div>
      ))}
    </>
  );
}

function ProviderMark({ provider }: { provider: ExternalProvider }) {
  return (
    <span className={`external-provider-mark ${provider}`} title={PROVIDER_LABELS[provider]}>
      {PROVIDER_MARKS[provider]}
    </span>
  );
}

function ImportResult({ result }: { result: ExternalSessionImportResult }) {
  return (
    <div className="external-import-result">
      <Check size={28} />
      <strong>{result.importedSessionIds.length} 个会话已导入</strong>
      <span>{result.importedMessages} 条新消息</span>
      {result.errors.map((item, index) => (
        <div className="external-scan-warning" key={`${item.provider}-${item.externalId}-${index}`}>
          {PROVIDER_LABELS[item.provider]}: {item.message}
        </div>
      ))}
    </div>
  );
}
