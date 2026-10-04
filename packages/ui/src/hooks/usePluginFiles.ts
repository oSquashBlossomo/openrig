// Slice 28 Checkpoint C-2 — plugin docs-browser file hooks.
//
// Wraps the new daemon endpoints (SC-29 EXCEPTION #11) added in
// Checkpoint C-1:
//   GET /api/plugins/:id/files/list?path=<rel>  → usePluginFilesList
//   GET /api/plugins/:id/files/read?path=<rel>  → usePluginFilesRead
//
// Same react-query shape as useFilesList / useFilesRead but the daemon
// returns response objects scoped to a single plugin (no allowlist root
// concept). Plugins live outside the operator's OPENRIG_FILES_ALLOWLIST,
// so this is the only way to browse plugin folder contents at v0.

import { useQuery } from "@tanstack/react-query";
import type { FileEntry } from "./useFiles.js";
import { readCatalogFile, readCatalogFilesList } from "../lib/catalog-file-read.js";

export interface PluginFilesListResponse {
  pluginId: string;
  path: string;
  entries: FileEntry[];
}

export interface PluginFilesReadResponse {
  pluginId: string;
  path: string;
  absolutePath: string;
  content: string;
  mtime: string;
  contentHash: string;
  size: number;
  truncated?: boolean;
  truncatedAtBytes?: number | null;
  totalBytes?: number;
}

export function usePluginFilesList(pluginId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["plugin-files", "list", pluginId, path],
    queryFn: ({ signal }) => readCatalogFilesList("plugin", pluginId, path, signal),
    enabled: !!pluginId,
    staleTime: 15_000,
    retry: false,
    placeholderData: undefined,
  });
}

export function usePluginFilesRead(pluginId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["plugin-files", "read", pluginId, path],
    queryFn: ({ signal }) => readCatalogFile("plugin", pluginId, path, signal),
    enabled: !!pluginId && !!path,
    staleTime: 15_000,
    retry: false,
    placeholderData: undefined,
  });
}
