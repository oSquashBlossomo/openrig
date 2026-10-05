import { useQueryClient } from "@tanstack/react-query";
import { useSelectedHostId, type HostsResponse } from "../../hooks/useHosts.js";
import { fileOriginAdmission, type FileOriginAdmission } from "./file-source.js";

/** The selected host only when the shared hosts read has actually landed.
 * Re-renders on selection changes through the shared hosts observer. */
export function useKnownSelectedHost(): string | undefined {
  const hostId = useSelectedHostId();
  const known = useQueryClient().getQueryData<HostsResponse>(["hosts"])?.selected === hostId;
  return known ? hostId : undefined;
}

export function useFileOriginAdmission(originInstance: string | null | undefined): FileOriginAdmission {
  return fileOriginAdmission(originInstance, useKnownSelectedHost());
}
