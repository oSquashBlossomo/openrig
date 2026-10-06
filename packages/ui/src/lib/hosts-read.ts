import type { HostsResponse } from "../hooks/useHosts.js";
import { arrayOf, hasShape, isBoolean, isText, LOCAL_OPERATOR_INSTANCE, oneOf, operatorRead, optional,
  type OperatorReadOptions } from "./operator-read.js";

const identity = (value: unknown): value is string => isText(value) && value.trim().length > 0;

/** The selected alias may have been removed from the registry. Preserve it so
 * consumers can report the unavailable selection rather than silently go local.
 * Entries retain their pointer-only/additive fields from the actual route. */
export function isHostsResponse(value: unknown): value is HostsResponse {
  return hasShape(value, {
    ownName: isText, selected: identity,
    hosts: arrayOf(row => hasShape(row, {
      id: identity, transport: oneOf("ssh", "http"), selected: isBoolean,
      status: oneOf("reachable", "unreachable", "unknown"),
      target: optional(isText), url: optional(isText), notes: optional(isText),
      bearer_env: optional(isText), bearer_file: optional(isText),
    }) && (row.transport === "http" ? identity(row.url) : identity(row.target))),
  });
}

export function readHosts(options: OperatorReadOptions = {}): Promise<HostsResponse> {
  return operatorRead(LOCAL_OPERATOR_INSTANCE, "/api/hosts", isHostsResponse, options);
}
