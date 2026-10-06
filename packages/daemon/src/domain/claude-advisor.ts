/** A launch-only override: never writes shared project or user settings. */
export function claudeAdvisorArgs(advisorModel?: string | null): string[] {
  if (advisorModel == null) return [];
  return ["--settings", JSON.stringify({ advisorModel: advisorModel === "off" ? "" : advisorModel })];
}
