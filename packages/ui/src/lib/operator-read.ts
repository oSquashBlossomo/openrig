export type OperatorInstanceScope = { kind: "local-instance" } | { kind: "remote-instance"; hostId: string };
export const LOCAL_OPERATOR_INSTANCE = { kind: "local-instance" } as const;
export type OperatorReadErrorCode = "unsupported_scope" | "invalid_request" | "cancelled" | "timeout"
  | "network" | "http" | "invalid_json" | "invalid_contract";
export class OperatorReadError extends Error {
  constructor(readonly code: OperatorReadErrorCode, message: string, readonly status?: number, readonly serverCode?: string) {
    super(message); this.name = "OperatorReadError";
  }
}
export interface OperatorReadOptions { signal?: AbortSignal; headers?: Readonly<Record<string, string>> }
export interface OperatorHookOptions { enabled?: boolean }

export function operatorScopeState(scope: OperatorInstanceScope) {
  return { scopeSupported: scope.kind === "local-instance", scopeError: scope.kind === "remote-instance"
    ? new OperatorReadError("unsupported_scope", `Canonical operator reads are unavailable for remote host ${scope.hostId}; these endpoints describe the connected local instance.`) : null };
}
export function operatorScopeKey(scope: OperatorInstanceScope): readonly string[] {
  return scope.kind === "local-instance" ? ["operator", "local-instance"] : ["operator", "remote-instance", scope.hostId];
}
export const OPERATOR_QUERY_OPTIONS = {
  retry: false, staleTime: 10_000, refetchInterval: 30_000, refetchOnWindowFocus: "always",
  // Override any global keepPreviousData default: another scope/entity is never
  // evidence for this selection while its own read is pending.
  placeholderData: undefined,
} as const;

/** The deadline owns both fetch headers and the JSON body, including implementations
 * which ignore AbortSignal. Caller cancellation stays distinct from a timeout. */
export async function operatorRead<T>(scope: OperatorInstanceScope, route: string,
  validate: (value: unknown) => value is T, options: OperatorReadOptions = {}): Promise<T> {
  const scopeError = operatorScopeState(scope).scopeError;
  if (scopeError) throw scopeError;
  if (options.signal?.aborted) throw new OperatorReadError("cancelled", "Operator read cancelled.");
  const controller = new AbortController();
  let response: Response | undefined;
  let abortError: OperatorReadError | undefined;
  let rejectAbort!: (error: OperatorReadError) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = (code: "cancelled" | "timeout") => {
    abortError = new OperatorReadError(code, code === "timeout" ? "Operator read timed out after 5 seconds." : "Operator read cancelled.");
    // Reject the independent deadline before the native fetch abort rejection.
    rejectAbort(abortError); controller.abort();
    void response?.body?.cancel().catch(() => {});
  };
  const onCallerAbort = () => abort("cancelled");
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => abort("timeout"), 5_000);
  const request = (async () => {
    try {
      response = await fetch(route, { method: "GET", headers: { ...options.headers, Accept: "application/json" }, signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw abortError; }
      let data: unknown;
      try { data = await response.json(); }
      catch {
        if (!response.ok) throw new OperatorReadError("http", `GET ${route} returned HTTP ${response.status}.`, response.status);
        throw new OperatorReadError("invalid_json", `GET ${route} did not serve valid JSON.`);
      }
      if (!response.ok) {
        const code = isObject(data) && isText(data.error) ? data.error : undefined;
        const detail = isObject(data) && isText(data.message) ? data.message : code;
        throw new OperatorReadError("http", `GET ${route} returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`, response.status, code);
      }
      if (!validate(data)) throw new OperatorReadError("invalid_contract", `GET ${route} did not serve the canonical operator contract.`);
      return data;
    } catch (error) {
      if (abortError) throw abortError;
      if (error instanceof OperatorReadError) throw error;
      throw new OperatorReadError("network", `GET ${route} could not be read from the connected instance.`);
    }
  })();
  try { return await Promise.race([request, aborted]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onCallerAbort); }
}

// Structural guards stay browser-only. Endpoint modules validate their own typed
// projections and retain the original object, including additive server fields.
export type Check = (value: unknown) => boolean;
export function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function isText(value: unknown): value is string { return typeof value === "string"; }
export const isNumber: Check = value => typeof value === "number" && Number.isFinite(value);
export const isInteger: Check = value => isNumber(value) && Number.isInteger(value) && (value as number) >= 0;
export const isBoolean: Check = value => typeof value === "boolean";
export const nullable = (check: Check): Check => value => value === null || check(value);
export const optional = (check: Check): Check => value => value === undefined || check(value);
export const arrayOf = (check: Check): Check => value => Array.isArray(value) && value.every(check);
export const oneOf = (...values: readonly unknown[]): Check => value => values.includes(value);
export function hasShape(value: unknown, fields: Record<string, Check>): value is Record<string, unknown> {
  return isObject(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
}
