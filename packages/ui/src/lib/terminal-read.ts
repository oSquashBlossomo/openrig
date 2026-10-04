import { LOCAL_HOST_ID } from "./host-param.js";
import { arrayOf, hasShape, isBoolean, isInteger, isText, nullable, optional, OperatorReadError,
  type OperatorReadOptions } from "./operator-read.js";

export interface SavedViewMemberDto { seat: string; label?: string; host?: string; tmuxSession?: string; readOnly?: boolean }
export interface SavedViewDto { id: string; name: string; members: SavedViewMemberDto[] }
export interface TerminalViewsResponse { saved: SavedViewDto[]; rigs: string[] }
export interface TerminalPreviewPane { seat: string; label: string; readOnly: boolean; paneCommand: string }
export interface TerminalPreviewDto {
  provider: string; view: string; planId: string; status: { available: boolean };
  composed: { id: string; opened: TerminalPreviewPane[]; pages: TerminalPreviewPane[][];
    absent: { seat: string; host: string | null; reason: string }[]; degraded: { seat: string; host: string; reason: string }[] };
  grids: { columns: number; rows: number; blanks: number }[];
}
const exactText = (v: unknown): v is string => isText(v) && !!v.trim();
/** This route family is excluded from daemon host read-through. A remote member
 * inside a local saved view is independent of the selected-daemon read scope. */
export function terminalReadScope(hostId: string | undefined) {
  const scopeSupported = hostId === LOCAL_HOST_ID;
  const scopeError = scopeSupported ? null : !exactText(hostId)
    ? new OperatorReadError("invalid_request", "Read the host selection before reading terminal views.")
    : new OperatorReadError("unsupported_scope", `Terminal catalog and preview are unavailable for selected remote host ${hostId}; select the connected local instance.`);
  return { scopeSupported, scopeError };
}
export function isTerminalViews(v: unknown): v is TerminalViewsResponse {
  return hasShape(v, { saved: arrayOf(row => hasShape(row, { id: exactText, name: isText,
    members: arrayOf(member => hasShape(member, { seat: exactText, label: optional(isText), host: optional(isText),
      tmuxSession: optional(isText), readOnly: optional(isBoolean) })) })), rigs: arrayOf(exactText) });
}
const pane = (v: unknown) => hasShape(v, { seat: exactText, label: isText, readOnly: isBoolean, paneCommand: isText });
export function isTerminalPreview(v: unknown): v is TerminalPreviewDto {
  if (!hasShape(v, { provider: exactText, view: exactText, planId: exactText,
    status: s => hasShape(s, { available: isBoolean }),
    composed: c => hasShape(c, { id: isText, opened: arrayOf(pane), pages: arrayOf(arrayOf(pane)),
      absent: arrayOf(s => hasShape(s, { seat: exactText, host: nullable(isText), reason: isText })),
      degraded: arrayOf(s => hasShape(s, { seat: exactText, host: isText, reason: isText })) }),
    grids: arrayOf(g => hasShape(g, { columns: n => isInteger(n) && (n as number) > 0,
      rows: n => isInteger(n) && (n as number) > 0, blanks: isInteger })),
  })) return false;
  const preview = v as unknown as TerminalPreviewDto;
  const panes = preview.composed.pages.flat();
  return preview.grids.length === preview.composed.pages.length && panes.length === preview.composed.opened.length
    && panes.every((p, index) => {
      const opened = preview.composed.opened[index]!;
      return p.seat === opened.seat && p.label === opened.label && p.readOnly === opened.readOnly && p.paneCommand === opened.paneCommand;
    }) && preview.grids.every((g, index) => g.columns * g.rows === preview.composed.pages[index]!.length + g.blanks);
}
function requireScope(hostId: string | undefined) { const error = terminalReadScope(hostId).scopeError; if (error) throw error; }
/** One deadline covers headers and body even when a fetch implementation ignores
 * abort. Keep the terminal consumer's existing network-error disclosure. */
async function terminalRead<T>(route: string, validate: (value: unknown) => value is T, options: OperatorReadOptions, preview = false): Promise<T> {
  if (options.signal?.aborted) throw new OperatorReadError("cancelled", "Terminal read cancelled.");
  const controller = new AbortController(); let response: Response | undefined; let abortError: OperatorReadError | undefined;
  let rejectAbort!: (error: OperatorReadError) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (code: "cancelled" | "timeout") => {
    abortError = new OperatorReadError(code, code === "timeout" ? "Terminal read timed out after 5 seconds." : "Terminal read cancelled.");
    rejectAbort(abortError); controller.abort(); void response?.body?.cancel().catch(() => {});
  };
  const onAbort = () => abort("cancelled"); options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort("timeout"), 5_000);
  const request = (async () => {
    try {
      response = await fetch(route, { method: "GET", headers: { ...options.headers, Accept: "application/json" }, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw abortError; }
      let value: unknown;
      try { value = await response.json(); }
      catch { throw new OperatorReadError(response.ok ? "invalid_json" : "http", response.ok ? "Terminal response was not valid JSON." : `HTTP ${response.status}`, response.ok ? undefined : response.status); }
      if (!response.ok) {
        const serverCode = hasShape(value, { error: isText }) ? value.error as string : undefined;
        throw new OperatorReadError("http", serverCode ?? `HTTP ${response.status}`, response.status, serverCode);
      }
      if (!validate(value)) throw new OperatorReadError("invalid_contract", preview ? "Terminal preview could not be verified. Refresh before Open." : "Terminal catalog could not be verified. Refresh to read views.");
      return value;
    } catch (error) {
      if (abortError) throw abortError;
      if (error instanceof OperatorReadError) throw error;
      throw new OperatorReadError("network", error instanceof Error ? error.message : "Terminal read could not reach the connected instance.");
    }
  })();
  try { return await Promise.race([request, aborted]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}
export async function readTerminalViews(hostId: string | undefined, options: OperatorReadOptions = {}) {
  requireScope(hostId);
  return terminalRead("/api/terminal/views", isTerminalViews, options);
}
/** Tokens and opaque plan IDs are retained byte-for-byte. Never reinterpret a
 * bare saved ID as a rig token or substitute another provider's cached plan. */
export async function readTerminalPreview(hostId: string, view: string | undefined, provider: string, options: OperatorReadOptions = {}) {
  requireScope(hostId);
  if (!exactText(view) || !exactText(provider)) throw new OperatorReadError("invalid_request", "Choose an exact terminal view and provider before preview.");
  const params = new URLSearchParams({ view, provider });
  return terminalRead(`/api/terminal/preview?${params}`,
    (v): v is TerminalPreviewDto => isTerminalPreview(v) && v.view === view && v.provider === provider, options, true);
}
