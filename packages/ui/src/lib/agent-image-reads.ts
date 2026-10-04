import type { AgentImageEntry, AgentImagePreview } from "../hooks/useAgentImageLibrary.js";
import { boundedJsonRead } from "./bounded-json-read.js";
import { arrayOf, hasShape, isBoolean, isNumber, isObject, isText, nullable, oneOf, optional, OperatorReadError } from "./operator-read.js";

// These endpoints describe the connected daemon's image catalog. They do not
// forward selected-host reads and do not confer mutation authority.
const stats = (value: unknown) => hasShape(value, {
  forkCount: isNumber, lastUsedAt: nullable(isText), estimatedSizeBytes: isNumber,
  lineage: arrayOf(isText),
});
const files = arrayOf(value => hasShape(value, {
  path: isText, role: isText, summary: nullable(isText), absolutePath: nullable(isText),
  bytes: nullable(isNumber), estimatedTokens: nullable(isNumber),
}));
const shared = {
  id: (value: unknown) => isText(value) && value.length > 0,
  name: isText, version: isText, runtime: oneOf("claude-code", "codex"),
  sourceSeat: isText, notes: nullable(isText), manifestEstimatedTokens: nullable(isNumber),
  derivedEstimatedTokens: isNumber, stats, files, lineage: arrayOf(isText), pinned: isBoolean,
};
function isEntry(value: unknown): value is AgentImageEntry {
  return hasShape(value, {
    ...shared, kind: oneOf("agent-image"), sourceSessionId: isText, sourceResumeToken: isText,
    // Older manifests/servers may omit this newer fact. Keep absence distinct
    // from a fabricated cwd; the consumer already presents it as unknown.
    sourceCwd: optional(nullable(isText)), createdAt: isText,
    sourceType: oneOf("user_file", "workspace", "builtin"), sourcePath: isText,
    relativePath: isText, updatedAt: isText,
  });
}

export async function readAgentImages(signal?: AbortSignal): Promise<AgentImageEntry[]> {
  const value = await boundedJsonRead<unknown>("/api/agent-images/library", { signal });
  if (!Array.isArray(value) || !value.every(isEntry)) {
    throw new OperatorReadError("invalid_contract", "Agent image library returned an invalid catalog.");
  }
  return value;
}

export async function readAgentImagePreview(id: string | null, signal?: AbortSignal): Promise<AgentImagePreview> {
  if (typeof id !== "string" || id.length === 0) {
    throw new OperatorReadError("invalid_request", "Select an exact agent image before requesting its preview.");
  }
  const value = await boundedJsonRead<unknown>(`/api/agent-images/library/${encodeURIComponent(id)}/preview`, { signal });
  if (!isObject(value) || value.id !== id || !hasShape(value, { ...shared, starterSnippet: isText })) {
    throw new OperatorReadError("invalid_contract", "Agent image preview did not match the requested image.");
  }
  return value as unknown as AgentImagePreview;
}
