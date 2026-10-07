/** A launch-only override: never writes shared project or user settings. */
export function claudeAdvisorArgs(advisorModel?: string | null): string[] {
  if (advisorModel == null) return [];
  return ["--settings", JSON.stringify({ advisorModel: advisorModel === "off" ? "" : advisorModel })];
}

/** One merged --settings value per launch: a second flag could shadow the launch-only
 *  operational settings (kernel authority, non-interruptive) instead of adding the advisor. */
export function claudeLaunchSettingsArgs(operational: string[], advisorModel?: string | null): { operational: string[]; advisor: string[] } {
  const advisor = claudeAdvisorArgs(advisorModel);
  const index = operational.indexOf("--settings");
  if (!advisor.length || index < 0) return { operational, advisor };
  const merged = { ...(JSON.parse(operational[index + 1]!) as Record<string, unknown>), ...(JSON.parse(advisor[1]!) as Record<string, unknown>) };
  return { operational: [...operational.slice(0, index), "--settings", JSON.stringify(merged), ...operational.slice(index + 2)], advisor: [] };
}
