import { useQuery } from "@tanstack/react-query";
import { arrayOf, hasShape, isBoolean, isNumber, isText, nullable, oneOf, optional, operatorRead, operatorScopeKey, operatorScopeState, OperatorReadError, OPERATOR_QUERY_OPTIONS, type OperatorHookOptions, type OperatorInstanceScope, type OperatorReadOptions } from "../lib/operator-read.js";
/** Mirrors the daemon's safe browser DTO; raw editable settings are a separate API. */
export type ConfigurationValue = string | number | boolean | null;
export type ConfigurationSourceState = "available" | "missing" | "malformed" | "unavailable";
export interface ConfigurationBrowserEntry {
  key: string; group: "general" | "slack" | "people" | "hosts" | "health";
  value: ConfigurationValue; defaultValue: ConfigurationValue; defaultKnown: boolean; subject?: string;
  source: "env" | "file" | "default" | "unreported" | "unavailable";
  visibility: "shown" | "withheld" | "unavailable"; reason: string | null; scope: string; application: string;
}
export interface ConfigurationBrowserSource { id: string; state: ConfigurationSourceState; path: string | null; detail: string }
export interface ConfigurationBrowser { observedAt: string; home: string | null; sources: ConfigurationBrowserSource[]; entries: ConfigurationBrowserEntry[]; exclusions: string[]; readOnly: true }
const scalar = (v: unknown) => v === null || isText(v) || isBoolean(v) || isNumber(v);
function isConfigurationBrowser(v: unknown): v is ConfigurationBrowser {
  return hasShape(v, { observedAt: isText, home: nullable(isText), readOnly: oneOf(true), exclusions: arrayOf(isText),
    sources: arrayOf(x => hasShape(x, { id: isText, state: oneOf("available", "missing", "malformed", "unavailable"), path: nullable(isText), detail: isText })),
    entries: arrayOf(x => hasShape(x, { key: isText, group: oneOf("general", "slack", "people", "hosts", "health"), value: scalar, defaultValue: scalar, defaultKnown: isBoolean, subject: optional(isText), source: oneOf("env", "file", "default", "unreported", "unavailable"), visibility: oneOf("shown", "withheld", "unavailable"), reason: nullable(isText), scope: isText, application: isText })),
  });
}
export function readConfigurationBrowser(scope: OperatorInstanceScope, options: OperatorReadOptions = {}) {
  return operatorRead(scope, "/api/config?view=browser", isConfigurationBrowser, options);
}
export function useConfigurationBrowser(scope: OperatorInstanceScope, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<ConfigurationBrowser, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...operatorScopeKey(scope), "configuration", "browser"], queryFn: ({ signal }) => readConfigurationBrowser(scope, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false });
  return { ...query, ...scopeState };
}
