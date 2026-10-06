import type { PluginFilesListResponse, PluginFilesReadResponse } from "../hooks/usePluginFiles.js";
import type { SkillFilesListResponse, SkillFilesReadResponse } from "../hooks/useSkillFiles.js";
import { boundedJsonRead } from "./bounded-json-read.js";
import { arrayOf, hasShape, isBoolean, isInteger, isText, nullable, oneOf, optional, OperatorReadError } from "./operator-read.js";

type Family = "plugin" | "skill";
type ListResponses = { plugin: PluginFilesListResponse; skill: SkillFilesListResponse };
type ReadResponses = { plugin: PluginFilesReadResponse; skill: SkillFilesReadResponse };

function readTarget(family: Family, id: string | null, path: string | null, operation: "list" | "read") {
  const relativePath = operation === "list" ? path ?? "" : path;
  if (typeof id !== "string" || !id || typeof relativePath !== "string" || (operation === "read" && !relativePath)) {
    throw new OperatorReadError("invalid_request", "Choose an exact catalog entry and relative file path before reading.");
  }
  try {
    return { id, path: relativePath, route: `/api/${family}s/${encodeURIComponent(id)}/files/${operation}?path=${encodeURIComponent(relativePath)}` };
  } catch {
    throw new OperatorReadError("invalid_request", "Catalog file identity is not valid Unicode.");
  }
}

function requireIdentity(value: unknown, family: Family, id: string, path: string) {
  return hasShape(value, { [`${family}Id`]: candidate => candidate === id, path: candidate => candidate === path });
}
function invalidResponse(): never {
  throw new OperatorReadError("invalid_contract", "Catalog file response could not be verified for this entry and path.");
}

/** These APIs describe the connected instance's discovered catalog. Keep that
 * existing scope: selected-host state must not turn this into remote forwarding.
 * Original path spelling is echoed by the daemon; absolutePath can separately
 * resolve a symlink. Retain both facts without client-side path normalization. */
export async function readCatalogFilesList<K extends Family>(family: K, id: string | null, path: string | null,
  signal?: AbortSignal): Promise<ListResponses[K]> {
  const target = readTarget(family, id, path, "list");
  const value = await boundedJsonRead<unknown>(target.route, { signal });
  if (!requireIdentity(value, family, target.id, target.path) || !hasShape(value, {
    entries: arrayOf(entry => hasShape(entry, {
      name: isText, type: oneOf("dir", "file", "other"), size: nullable(isInteger), mtime: nullable(isText),
    })),
  })) invalidResponse();
  return value as unknown as ListResponses[K];
}

export async function readCatalogFile<K extends Family>(family: K, id: string | null, path: string | null,
  signal?: AbortSignal): Promise<ReadResponses[K]> {
  const target = readTarget(family, id, path, "read");
  const value = await boundedJsonRead<unknown>(target.route, { signal });
  if (!requireIdentity(value, family, target.id, target.path) || !hasShape(value, {
    absolutePath: isText, content: isText, mtime: isText, contentHash: isText, size: isInteger,
    truncated: optional(isBoolean), truncatedAtBytes: optional(nullable(isInteger)), totalBytes: optional(isInteger),
  })) invalidResponse();
  return value as unknown as ReadResponses[K];
}
