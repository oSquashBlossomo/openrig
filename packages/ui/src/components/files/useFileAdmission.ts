import { useConfirmedFilesHost } from "../../hooks/useFiles.js";
import { fileOriginAdmission, type FileOriginAdmission } from "./file-source.js";

/** The selected host only while the shared hosts read confirms authority.
 * Failed refreshes retain data, so observe query status as well as selection. */
export function useKnownSelectedHost(): string | undefined {
  return useConfirmedFilesHost();
}

export function useFileOriginAdmission(originInstance: string | null | undefined): FileOriginAdmission {
  return fileOriginAdmission(originInstance, useKnownSelectedHost());
}
