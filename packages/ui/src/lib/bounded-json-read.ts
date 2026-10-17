import { OperatorReadError } from "./operator-read.js";

export interface BoundedJsonReadOptions<T> {
  signal?: AbortSignal;
  /** Caller-owned headers, passed verbatim; ordinary reads add none. */
  headers?: HeadersInit;
  /** Explicit fetch cache policy (e.g. "no-store" for a fresh identity
   *  check); ordinary reads set none. */
  cache?: RequestCache;
  /** Own status/body interpretation (e.g. legacy 503/404 shapes). The entire
   * callback shares the request's deadline; domain errors pass through. */
  readResponse?: (response: Response) => T | Promise<T>;
}

/** Scope-neutral GET transport. One five-second deadline includes headers and
 * the response decoder, even when either ignores AbortSignal. */
export async function boundedJsonRead<T>(route: string, options: BoundedJsonReadOptions<T> = {}): Promise<T> {
  if (options.signal?.aborted) throw new OperatorReadError("cancelled", "Read cancelled.");
  const controller = new AbortController();
  let response: Response | undefined;
  let responseDisposed = false;
  let abortError: OperatorReadError | undefined;
  let rejectAbort!: (error: OperatorReadError) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const dispose = () => {
    if (!response?.body || response.bodyUsed || responseDisposed) return;
    responseDisposed = true;
    void response.body.cancel().catch(() => {});
  };
  const abort = (code: "cancelled" | "timeout") => {
    if (abortError) return;
    abortError = new OperatorReadError(code, code === "timeout" ? "Read timed out after 5 seconds." : "Read cancelled.");
    rejectAbort(abortError); controller.abort(); dispose();
  };
  const onAbort = () => abort("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort("timeout"), 5_000);
  const request = (async () => {
    try {
      try { response = await fetch(route, { method: "GET", signal: controller.signal,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.cache === undefined ? {} : { cache: options.cache }) }); }
      catch (error) {
        if (abortError) throw abortError;
        throw new OperatorReadError("network", error instanceof Error ? error.message : "Read could not reach the server.");
      }
      if (abortError) { dispose(); throw abortError; }
      let value: T;
      if (options.readResponse) {
        try { value = await options.readResponse(response); }
        catch (error) {
          if (error instanceof SyntaxError) throw new OperatorReadError("invalid_json", "Response was not valid JSON.");
          throw error;
        }
      } else {
        if (!response.ok) { dispose(); throw new Error(`HTTP ${response.status}`); }
        try { value = await response.json() as T; }
        catch { throw new OperatorReadError("invalid_json", "Response was not valid JSON."); }
      }
      if (abortError) throw abortError;
      return value;
    } catch (error) { if (abortError) throw abortError; throw error; }
    finally { dispose(); }
  })();
  try { return await Promise.race([request, aborted]); }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); }
}
