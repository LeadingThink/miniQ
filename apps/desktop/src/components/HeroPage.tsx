import { useState } from "react";
import { PlugZap, Sparkles } from "lucide-react";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { ComposerSlashCommand } from "../composerSlash";
import { hostDraftKey } from "../desktopHost";
import { ComposerCard } from "./Composer";
import { ProjectPicker } from "./ProjectPicker";
import { ProviderOnboardingPrompt } from "./ProviderOnboardingPrompt";
import { SessionModelControls } from "./SessionModelControls";
import { StarterPrompts } from "./StarterPrompts";

export function HeroPage({
  app,
  slashCommands,
  sendBlockedReason,
}: {
  app: MiniqAppController;
  slashCommands: ComposerSlashCommand[];
  sendBlockedReason?: string;
}) {
  const selectedWorkspace = app.catalog.selectedWorkspace;
  const [draftRequest, setDraftRequest] = useState<
    { id: number; content: string } | undefined
  >();
  return (
    <div className="hero">
      <header className="hero-heading">
        <h1>
          {selectedWorkspace ? (
            <>
              要在{" "}
              <span className="hero-project-name">
                {selectedWorkspace.name}
              </span>{" "}
              中完成什么？
            </>
          ) : (
            "今天想完成什么？"
          )}
        </h1>
        <p>自主规划、执行工作流与信息提取</p>
      </header>
      <div className="hero-composer">
        {app.connection.providerConfigured === false && (
          <ProviderOnboardingPrompt
            onOpenSettings={() => app.navigation.openSettings("services")}
          />
        )}
        <ComposerCard
          onVoiceFocusApplied={app.actions.companionVoiceHandled}
          voiceFocusRequest={
            app.companionVoiceRequest?.sessionId === null &&
            app.companionVoiceRequest.workspaceId === selectedWorkspace?.id
              ? app.companionVoiceRequest.id
              : undefined
          }
          slashCommands={slashCommands}
          workspaceId={selectedWorkspace?.id}
          modelSlot={
            <SessionModelControls
              client={app.client}
              model={app.sessionModel}
              busy={false}
              placement="below"
            />
          }
          busy={false}
          draftKey={hostDraftKey(
            app.client.sshHost,
            "hero",
            app.client.storageScope,
          )}
          draftRequest={draftRequest}
          client={app.client}
          placeholder={
            selectedWorkspace
              ? "描述你的目标，例如：整理这份资料并生成周报"
              : "先选择一个项目，再描述你的目标"
          }
          chipSlot={
            <ProjectPicker
              workspaces={app.catalog.workspaces}
              selectedId={selectedWorkspace?.id ?? null}
              onSelect={app.actions.selectProject}
              onCreateBlank={(name) =>
                void app.actions.createBlankProject(name)
              }
              onOpenFolder={() => void app.actions.openWorkspace()}
            />
          }
          approvalMode={app.connection.approvalMode}
          onApprovalModeChange={app.connection.changeApprovalMode}
          allowGoal
          onSend={app.actions.startTask}
          onError={app.setError}
          sendBlocked={!!sendBlockedReason}
          sendBlockedReason={sendBlockedReason}
        />
      </div>
      <StarterPrompts
        onSelect={(prompt) =>
          setDraftRequest({ id: Date.now(), content: prompt.prompt })
        }
        shortcuts={[
          {
            id: "skills",
            title: "技能",
            description: "查看可复用的工作流，或从任务中学习新技能",
            icon: Sparkles,
            onSelect: () => app.navigation.setPage("skills"),
          },
          {
            id: "mcp",
            title: "连接器",
            description: "接入办公应用、外部工具与数据服务",
            icon: PlugZap,
            onSelect: () => app.navigation.setPage("mcp"),
          },
        ]}
      />
    </div>
  );
}
