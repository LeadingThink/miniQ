import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import type { ComposerSlashCommand } from "../composerSlash";
import { errorMessage } from "../errorMessage";

interface Skill {
  name: string;
  description: string;
  enabled: boolean;
}

export function useSlashSkills(
  client: RpcClient | undefined,
  active: boolean,
  workspaceId?: string,
) {
  const [result, setResult] = useState<{
    scope: string;
    commands: ComposerSlashCommand[];
  }>({ scope: "", commands: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const scope = workspaceId ?? "";
  useEffect(() => {
    if (!active || !client) return;
    let stale = false;
    setLoading(true);
    setError(null);
    setResult({ scope, commands: [] });
    void client
      .call<{ skills: Skill[] }>(
        "skill.list",
        workspaceId ? { workspaceId } : {},
      )
      .then(({ skills }) => {
        if (stale) return;
        setResult({
          scope,
          commands: skills
            .filter((skill) => skill.enabled)
            .map((skill) => ({
              id: `skill:${skill.name}`,
              name: skill.name,
              description:
                skill.description || "将技能添加到消息，再补充任务要求",
              group: "技能",
              icon: "skills",
              keywords: ["skill", "技能"],
              insertText: `使用技能「${skill.name}」：`,
            })),
        });
      })
      .catch((cause) => {
        if (!stale) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [client, active, scope, workspaceId, attempt]);
  return {
    commands: client && result.scope === scope ? result.commands : [],
    loading: active && Boolean(client) && loading,
    error: active && client ? error : null,
    retry: () => setAttempt((value) => value + 1),
  };
}
