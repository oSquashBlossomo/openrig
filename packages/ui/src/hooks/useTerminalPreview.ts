import { useQuery } from "@tanstack/react-query";
import { readTerminalPreview, terminalReadScope } from "../lib/terminal-read.js";
export type { TerminalPreviewPane, TerminalPreviewDto } from "../lib/terminal-read.js";

/** Readiness and geometry belong to the daemon composer. Preview never opens panes. */
export function useTerminalPreview(hostId: string, view: string | undefined, provider: string, enabled: boolean) {
  const scope = terminalReadScope(hostId);
  const query = useQuery({
    queryKey: ["terminal", "preview", hostId, view, provider],
    enabled: enabled && !!view && scope.scopeSupported,
    retry: false, placeholderData: undefined,
    queryFn: ({ signal }) => readTerminalPreview(hostId, view, provider, { signal }),
  });
  return { ...query, ...scope, data: scope.scopeSupported ? query.data : undefined };
}
