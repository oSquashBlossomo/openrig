import type { FilesRootsResponse, FilesUnavailable, FilesListResponse, FilesReadResponse } from "../hooks/useFiles.js";
import { LOCAL_HOST_ID } from "./host-param.js";
import { arrayOf, hasShape, isBoolean, isInteger, isObject, isText, nullable, oneOf, optional,
  OperatorReadError, type OperatorReadOptions } from "./operator-read.js";

/** Keep the public FilesReadError constructor, code/status, name and message
 * byte-compatible. Transport/scope failures use OperatorReadError instead of
 * being mislabeled as disk absence or a path error. */
export class FilesReadError extends Error {
  readonly code: "absent" | "read_error" | "bad_path";
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "Error";
    this.status = status;
    this.code = status === 404 ? "absent" : status === 400 ? "bad_path" : "read_error";
  }
}
export interface FilesReadOptions extends Pick<OperatorReadOptions, "signal"> { enabled?: boolean }
const exactText = (v: unknown): v is string => isText(v) && !!v.trim();
export function filesReadScope(hostId: string | undefined) {
  const scopeSupported = hostId === LOCAL_HOST_ID;
  const scopeError = scopeSupported ? null : !exactText(hostId)
    ? new OperatorReadError("invalid_request", "Read the host selection before accessing local files.")
    : new OperatorReadError("unsupported_scope", `Local files are unavailable for selected remote host ${hostId}; select the connected local instance.`);
  return { scopeSupported, scopeError };
}
function requireRead(hostId: string | undefined, options: FilesReadOptions) {
  const error = filesReadScope(hostId).scopeError; if (error) throw error;
  if (options.enabled === false) throw new OperatorReadError("invalid_request", "Files read is disabled by its caller.");
}
export function isFilesRoots(v: unknown): v is FilesRootsResponse {
  return hasShape(v, { roots: arrayOf(r => hasShape(r, { name: exactText, path: exactText })), hint: optional(isText) });
}
export function isFilesList(v: unknown): v is FilesListResponse {
  return hasShape(v, { root: exactText, path: isText, entries: arrayOf(e => hasShape(e, {
    name: isText, type: oneOf("dir", "file", "other"), size: nullable(isInteger), mtime: nullable(isText) })) });
}
export function isFilesRead(v: unknown): v is FilesReadResponse {
  return hasShape(v, { root: exactText, path: isText, absolutePath: isText, resolvedPath: optional(isText), content: isText,
    mtime: isText, contentHash: isText, size: isInteger, binary: optional(isBoolean), truncated: optional(isBoolean),
    truncatedAtBytes: optional(nullable(isInteger)), totalBytes: optional(isInteger) });
}
/** A single deadline owns headers and JSON body even if fetch ignores abort.
 * Status-only failures need no body decode; roots' existing 503 setup payload
 * remains a successful unavailable result after its bounded body read. */
async function filesRead<T>(route: string, validate: (v: unknown) => v is T, options: FilesReadOptions, roots = false): Promise<T | FilesUnavailable> {
  if (options.signal?.aborted) throw new OperatorReadError("cancelled", "Files read cancelled.");
  const controller = new AbortController(); let response: Response | undefined; let abortError: OperatorReadError | undefined;
  let rejectAbort!: (error: OperatorReadError) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (code: "cancelled" | "timeout") => {
    if (abortError) return;
    abortError = new OperatorReadError(code, code === "timeout" ? "Files read timed out after 5 seconds." : "Files read cancelled.");
    rejectAbort(abortError); controller.abort(); void response?.body?.cancel().catch(() => {});
  };
  const onAbort = () => abort("cancelled"); options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort("timeout"), 5_000);
  const request = (async () => {
    try {
      response = await fetch(route, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw abortError; }
      const unavailable = roots && response.status === 503;
      if (!response.ok && !unavailable) { void response.body?.cancel().catch(() => {}); throw new FilesReadError(response.status); }
      let value: unknown;
      try { value = await response.json(); }
      catch {
        if (abortError) throw abortError;
        if (!unavailable) throw new OperatorReadError("invalid_json", "Files response was not valid JSON.");
      }
      if (controller.signal.aborted) throw abortError;
      if (unavailable) return { unavailable: true as const,
        error: isObject(value) && isText(value.error) ? value.error : "files_routes_unavailable",
        hint: isObject(value) && isText(value.hint) ? value.hint : undefined };
      if (!validate(value)) throw new OperatorReadError("invalid_contract", "Files response could not be verified for this target. Refresh before using it.");
      return value;
    } catch (error) {
      if (abortError) throw abortError;
      if (error instanceof FilesReadError || error instanceof OperatorReadError) throw error;
      throw new OperatorReadError("network", error instanceof Error ? error.message : "Files read could not reach the connected instance.");
    }
  })();
  try { return await Promise.race([request, aborted]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}
export async function readFilesRoots(hostId: string | undefined, options: FilesReadOptions = {}) {
  requireRead(hostId, options);
  return filesRead("/api/files/roots", isFilesRoots, options, true);
}
function requireTarget(root: string | null, path: string | null, file: boolean) {
  if (!exactText(root) || !isText(path) || (file && !path)) throw new OperatorReadError("invalid_request", "Choose an exact file root and relative path before reading.");
}
/** The route echoes ORIGINAL request spelling. './', repeated separators and
 * symlink aliases can resolve to another canonical resolvedPath/absolutePath;
 * preserve those facts rather than requiring a fabricated canonical echo. */
export async function readFilesList(hostId: string | undefined, root: string | null, path: string | null, options: FilesReadOptions = {}): Promise<FilesListResponse> {
  requireRead(hostId, options); requireTarget(root, path, false);
  return filesRead(`/api/files/list?root=${encodeURIComponent(root!)}&path=${encodeURIComponent(path!)}`,
    (v): v is FilesListResponse => isFilesList(v) && v.root === root && v.path === path, options) as Promise<FilesListResponse>;
}
export async function readFilesFile(hostId: string | undefined, root: string | null, path: string | null, options: FilesReadOptions = {}): Promise<FilesReadResponse> {
  requireRead(hostId, options); requireTarget(root, path, true);
  return filesRead(`/api/files/read?root=${encodeURIComponent(root!)}&path=${encodeURIComponent(path!)}`,
    (v): v is FilesReadResponse => isFilesRead(v) && v.root === root && v.path === path, options) as Promise<FilesReadResponse>;
}
