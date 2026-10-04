import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";

/** Reserved topology values must bypass qss numeric/boolean and JSON coercion.
 * Router.parseLocation reserializes parsed search, so both adapters are needed. */
const RAW_FIELDS = ["sourceHost", "selectedRig", "selectedNode", "spatialQuery"] as const;
const rawFields = new Set<string>(RAW_FIELDS);
class InvalidRawValue {
  constructor(readonly encoded: string) {}
}
export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function decode(value: string): string {
  const decoded = decodeURIComponent(value.replace(/\+/g, " "));
  if (hasUnpairedSurrogate(decoded)) throw new URIError("Unpaired surrogate");
  return decoded;
}
export function parseTopologySearch(search: string): Record<string, unknown> {
  const result: Record<string, unknown> = defaultParseSearch(search);
  const values = new Map<string, Array<string | InvalidRawValue>>();
  for (const pair of search.replace(/^\?/, "").split("&")) {
    const separator = pair.indexOf("=");
    let key: string;
    try { key = decode(separator < 0 ? pair : pair.slice(0, separator)); } catch { continue; }
    if (!rawFields.has(key)) continue;
    const encoded = separator < 0 ? "" : pair.slice(separator + 1);
    let value: string | InvalidRawValue;
    try { value = decode(encoded); } catch {
      // Keep malformed input invalid through the router's reserialization.
      // Never replace it with the URLSearchParams replacement character.
      value = new InvalidRawValue(hasUnpairedSurrogate(encoded) ? "%ED%A0%80" : encoded);
    }
    const existing = values.get(key) ?? [];
    existing.push(value); values.set(key, existing);
  }
  for (const [key, entries] of values) result[key] = entries.length === 1 ? entries[0] : entries;
  return result;
}
export function stringifyTopologySearch(search: Record<string, unknown>): string {
  const chunks: string[] = [];
  for (const key in search) {
    const value = search[key];
    if (value === undefined) continue;
    if (!rawFields.has(key)) {
      const encoded = defaultStringifySearch({ [key]: value });
      if (encoded) chunks.push(encoded.slice(1));
      continue;
    }
    const entries = Array.isArray(value) ? value : [value];
    if (!entries.length) throw new TypeError(`Topology ${key} must be an exact string.`);
    for (const entry of entries) {
      if (entry instanceof InvalidRawValue) {
        // A raw delimiter must not turn an invalid value into another field/hash.
        chunks.push(`${key}=${entry.encoded.replace(/&/g, "%26").replace(/#/g, "%23")}`);
      } else {
        if (typeof entry !== "string" || hasUnpairedSurrogate(entry))
          throw new TypeError(`Topology ${key} must be an exact string.`);
        chunks.push(new URLSearchParams([[key, entry]]).toString());
      }
    }
  }
  return chunks.length ? `?${chunks.join("&")}` : "";
}
