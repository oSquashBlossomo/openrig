// Saved membership and derived rig names only; readiness belongs to preview.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelectedHostId, type HostsResponse } from "./useHosts.js";
import { readTerminalViews, terminalReadScope } from "../lib/terminal-read.js";
export type { SavedViewMemberDto, SavedViewDto, TerminalViewsResponse } from "../lib/terminal-read.js";

export function useTerminalViews() {
  const hostId = useSelectedHostId();
  // The existing observer subscribes to host-cache changes without multiplying
  // /hosts polling. Its presumed-local default must not authorize this read.
  const selectionKnown = useQueryClient().getQueryData<HostsResponse>(["hosts"])?.selected === hostId;
  const scope = terminalReadScope(selectionKnown ? hostId : undefined);
  const query = useQuery({
    queryKey: ["terminal", "views", hostId], enabled: scope.scopeSupported,
    queryFn: ({ signal }) => readTerminalViews(selectionKnown ? hostId : undefined, { signal }),
    retry: false, placeholderData: undefined, refetchInterval: 30_000,
  });
  return { ...query, ...scope, selectionKnown, data: scope.scopeSupported ? query.data : undefined };
}
