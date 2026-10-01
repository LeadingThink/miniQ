/** The display title is presentation only; RPC calls always use name. */
export function skillDisplayName(skill: { name: string; displayName?: string | null }): string {
  return skill.displayName?.trim() || skill.name;
}
