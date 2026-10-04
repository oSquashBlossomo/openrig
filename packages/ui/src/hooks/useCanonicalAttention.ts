import { useQuery } from "@tanstack/react-query";
import type { AttentionRead } from "@openrig/daemon/attention";
import { arrayOf, hasShape, isBoolean, isInteger, isText, nullable, oneOf, optional, operatorRead, operatorScopeKey, operatorScopeState, OperatorReadError, OPERATOR_QUERY_OPTIONS, type Check, type OperatorHookOptions, type OperatorInstanceScope, type OperatorReadOptions } from "../lib/operator-read.js";
export type { AttentionRead, AttentionDetail, AttentionItem } from "@openrig/daemon/attention";
const textOrNull = nullable(isText);
const item: Check = v => hasShape(v, { id: isText, kind: oneOf("action", "update"), summary: isText, unblocks: textOrNull, urgency: isText, at: textOrNull, scope: isText, project: nullable(x => hasShape(x, { id: isText, root: isText })), source: isText, recipient: optional(textOrNull) });
function isAttention(v: unknown): v is AttentionRead {
  return hasShape(v, { scope: oneOf("instance"), readAt: isText, items: arrayOf(item), sources: arrayOf(x => hasShape(x, { source: isText, state: oneOf("available", "unavailable", "partial"), detail: isText })),
    detail: nullable(x => hasShape(x, { item, lines: arrayOf(isText), files: arrayOf(f => hasShape(f, { label: isText, path: isText })) })), detailError: textOrNull });
}
export async function readCanonicalAttention(scope: OperatorInstanceScope, itemId: string | null = null, options: OperatorReadOptions = {}) {
  if (itemId !== null && (!isText(itemId) || !itemId.trim())) throw new OperatorReadError("invalid_request", "Attention detail requires an exact item ID.");
  const route = itemId === null ? "/api/attention" : `/api/attention?${new URLSearchParams({ item: itemId })}`;
  return operatorRead(scope, route, (v): v is AttentionRead => isAttention(v) && (itemId === null || v.detail === null || v.detail.item.id === itemId), options);
}
export function useCanonicalAttention(scope: OperatorInstanceScope, itemId: string | null = null, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<AttentionRead, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...operatorScopeKey(scope), "attention", itemId === null ? "list" : "detail", itemId], queryFn: ({ signal }) => readCanonicalAttention(scope, itemId, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false });
  return { ...query, ...scopeState };
}
export function useCanonicalAttentionDetail(scope: OperatorInstanceScope, itemId: string | null, options: OperatorHookOptions = {}) {
  return useCanonicalAttention(scope, itemId, { enabled: itemId !== null && options.enabled !== false });
}
/** Safe TUI-consumed subset of the delivered queue row; additive daemon fields remain intact. */
export interface DeliveredHumanUpdate { qitemId: string; summary: string | null; body: string; humanDetail: string | null; destinationSession: string; sourceSession: string; tags: string[] | null; evidenceRef: string | null; deliveredAt: string; deliveryReceipt: string }
export interface DeliveredHumanUpdates { items: DeliveredHumanUpdate[]; limit: number; truncated: boolean }
function isHumanUpdates(v: unknown): v is DeliveredHumanUpdates {
  return hasShape(v, { items: arrayOf(x => hasShape(x, { qitemId: isText, summary: textOrNull, body: isText, humanDetail: textOrNull, destinationSession: isText, sourceSession: isText, tags: nullable(arrayOf(isText)), evidenceRef: textOrNull, deliveredAt: isText, deliveryReceipt: isText })), limit: isInteger, truncated: isBoolean });
}
export async function readDeliveredHumanUpdates(scope: OperatorInstanceScope, limit = 20, options: OperatorReadOptions = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new OperatorReadError("invalid_request", "Delivered update limit must be an integer from 1 to 100.");
  return operatorRead(scope, `/api/queue/human-updates?limit=${limit}`, isHumanUpdates, options);
}
export function useDeliveredHumanUpdates(scope: OperatorInstanceScope, limit = 20, options: OperatorHookOptions = {}) {
  const scopeState = operatorScopeState(scope);
  const query = useQuery<DeliveredHumanUpdates, OperatorReadError>({ ...OPERATOR_QUERY_OPTIONS, queryKey: [...operatorScopeKey(scope), "attention", "human-updates", limit], queryFn: ({ signal }) => readDeliveredHumanUpdates(scope, limit, { signal }), enabled: scopeState.scopeSupported && options.enabled !== false });
  return { ...query, ...scopeState };
}
