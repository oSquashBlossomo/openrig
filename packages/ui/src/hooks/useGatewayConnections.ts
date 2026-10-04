import { useQuery } from "@tanstack/react-query";
import type { SlackManifestBundle } from "@openrig/daemon/gateway-slack";
import type { HumanPrefs, HumanConnectorBinding } from "@openrig/daemon/gateway-human-registry";
import { arrayOf, hasShape, isBoolean, isInteger, isText, nullable, oneOf, operatorRead, operatorScopeKey, operatorScopeState, OperatorReadError, OPERATOR_QUERY_OPTIONS, type OperatorHookOptions, type OperatorInstanceScope, type OperatorReadOptions } from "../lib/operator-read.js";
/** Mirrors connectionsProjection. A dated verification never proves current reachability. */
export interface GatewayConnections {
  observedAt: string; home: string | null; pid: number; settingsSource: string | null;
  settings: Array<{ key: string; value: string | null; source: string }>;
  configSource: { state: string; path: string | null; sourceState: "available" | "missing" | "malformed" | "unavailable" };
  configuration: null | { enabled: boolean; channel: string | null; inboundDestination: string | null; outboundDestinations: Array<string | null>; postLevel: string; interruptLevel: string; botToken: "resolved" | "missing" | "unavailable"; appToken: "resolved" | "missing" | "unavailable" };
  running: { state: string; activatedAt: string | null; outboundReady: boolean | null; inboundReady: boolean | null; inboundState: string; applied: "unverified" | "matching" | "changed" };
  state: "unavailable" | "failed" | "unapplied" | "unverified" | "disabled" | "incomplete" | "indeterminate"; nextAction: string;
  verification: { state: "unverified" | "changed" | "indeterminate" | "ready-at-check" | "failed"; at: string | null; actor: string | null };
  registry: { state: "available" | "unavailable"; path: string | null };
  humans: Array<{ browserKey: string; entityId: string; address: string; displayName: string | null; class: "human"; away: boolean | null; deliveryClass: HumanPrefs["deliveryClass"]; availability: NonNullable<HumanPrefs["availability"]>; excluded: boolean | null; bindings: Array<{ browserKey: string; kind: HumanConnectorBinding["kind"]; ref: string | null; role: HumanConnectorBinding["role"]; handle: string | null; credentialReference: boolean }> }>;
}
export type SlackManifest = SlackManifestBundle;
const textOrNull = nullable(isText);
function isConnections(v: unknown): v is GatewayConnections {
  return hasShape(v, { observedAt: isText, home: textOrNull, pid: isInteger, settingsSource: textOrNull,
    settings: arrayOf(x => hasShape(x, { key: isText, value: textOrNull, source: isText })),
    configSource: x => hasShape(x, { state: isText, path: textOrNull, sourceState: oneOf("available", "missing", "malformed", "unavailable") }),
    configuration: nullable(x => hasShape(x, { enabled: isBoolean, channel: textOrNull, inboundDestination: textOrNull, outboundDestinations: arrayOf(textOrNull), postLevel: isText, interruptLevel: isText, botToken: oneOf("resolved", "missing", "unavailable"), appToken: oneOf("resolved", "missing", "unavailable") })),
    running: x => hasShape(x, { state: isText, activatedAt: textOrNull, outboundReady: nullable(isBoolean), inboundReady: nullable(isBoolean), inboundState: isText, applied: oneOf("unverified", "matching", "changed") }),
    state: oneOf("unavailable", "failed", "unapplied", "unverified", "disabled", "incomplete", "indeterminate"), nextAction: isText,
    verification: x => hasShape(x, { state: oneOf("unverified", "changed", "indeterminate", "ready-at-check", "failed"), at: textOrNull, actor: textOrNull }),
    registry: x => hasShape(x, { state: oneOf("available", "unavailable"), path: textOrNull }),
    humans: arrayOf(x => hasShape(x, { browserKey: isText, entityId: isText, address: isText, displayName: textOrNull, class: oneOf("human"), away: nullable(isBoolean), deliveryClass: oneOf("A", "B", "C", "D"), availability: oneOf("available", "focus", "away", "off"), excluded: nullable(isBoolean), bindings: arrayOf(b => hasShape(b, { browserKey: isText, kind: oneOf("slack"), ref: textOrNull, role: oneOf("primary", "secondary"), handle: textOrNull, credentialReference: isBoolean })) })),
  });
}
function isManifest(v: unknown): v is SlackManifest {
  return hasShape(v, { yaml: isText, url: isText, scopes: arrayOf(isText), events: arrayOf(isText), manifest: m => hasShape(m, {
    display_information: x => hasShape(x, { name: isText, description: isText }), features: x => hasShape(x, { bot_user: b => hasShape(b, { display_name: isText, always_online: isBoolean }) }), oauth_config: x => hasShape(x, { scopes: s => hasShape(s, { bot: arrayOf(isText) }) }),
    settings: x => hasShape(x, { event_subscriptions: e => hasShape(e, { bot_events: arrayOf(isText) }), interactivity: i => hasShape(i, { is_enabled: isBoolean }), org_deploy_enabled: isBoolean, socket_mode_enabled: isBoolean, token_rotation_enabled: isBoolean }),
  }) });
}
export function readGatewayConnections(scope: OperatorInstanceScope, options: OperatorReadOptions = {}) { return operatorRead(scope, "/api/gateway/connections", isConnections, options); }
export function readSlackManifest(scope: OperatorInstanceScope, options: OperatorReadOptions = {}) { return operatorRead(scope, "/api/gateway/slack/manifest", isManifest, options); }
export function useGatewayConnections(scope: OperatorInstanceScope, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<GatewayConnections, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...operatorScopeKey(scope), "gateway", "connections"], queryFn: ({ signal }) => readGatewayConnections(scope, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false });
  return { ...query, ...scopeState };
}
export function useSlackManifest(scope: OperatorInstanceScope, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<SlackManifest, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...operatorScopeKey(scope), "gateway", "slack-manifest"], queryFn: ({ signal }) => readSlackManifest(scope, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false });
  return { ...query, ...scopeState };
}
