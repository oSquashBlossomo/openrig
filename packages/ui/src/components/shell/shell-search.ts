// Validated URL state for shell-owned routes (/terminals, /help).

/** `/terminals?view=<exact typed token>`. Kept byte for byte: never trimmed
 * or normalised (the catalog reports a malformed token explicitly). */
export interface TerminalsSearch { view?: string }

export function validateTerminalsSearch(search: Record<string, unknown>): TerminalsSearch {
  return typeof search.view === "string" && search.view.length > 0 && search.view.length <= 1024 ? { view: search.view } : {};
}

/** `/help?from=<app path>&q=<filter>`. `from` is an in-app path only, so
 * the return link can never leave the app. */
export interface HelpSearch { from?: string; q?: string }

const PROBE_ORIGIN = "https://openrig-app.invalid";

/**
 * Admits an exact in-app return path, or nothing. Browsers normalise "\" to
 * "/" and strip tab/newline in special-scheme URLs, so "/\host" or "/\n/host"
 * would resolve to another origin; any backslash or control character is
 * refused, and the remaining value must still resolve to this origin with a
 * root-relative path. Admitted bytes are returned unchanged (exact query,
 * hash and opaque identities such as "1.0").
 */
export function admitInAppPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return undefined;
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  let resolved: URL;
  try { resolved = new URL(value, PROBE_ORIGIN); } catch { return undefined; }
  if (resolved.origin !== PROBE_ORIGIN || !resolved.pathname.startsWith("/") || resolved.pathname.startsWith("//")) return undefined;
  return value;
}

export function validateHelpSearch(search: Record<string, unknown>): HelpSearch {
  const admitted = admitInAppPath(search.from);
  const from = admitted && !admitted.startsWith("/help") ? admitted : undefined;
  const q = typeof search.q === "string" && search.q.trim() && search.q.length <= 200 ? search.q : undefined;
  return { ...(from ? { from } : {}), ...(q ? { q } : {}) };
}
