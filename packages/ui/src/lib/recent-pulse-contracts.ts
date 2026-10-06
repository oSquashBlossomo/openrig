import { arrayOf, hasShape, isBoolean, isInteger, isText, nullable, optional, oneOf, operatorRead, operatorScopeKey, operatorScopeState, OperatorReadError, type OperatorInstanceScope, type OperatorReadOptions } from './operator-read.js';
import { isHumanSeatSessionRef } from './session-name.js';
export type RecentScope = {
  kind: 'instance';
} | {
  kind: 'rig';
  rig: string;
};
export interface RecentTransition {
  transitionId: number;
  qitemId: string;
  ts: string;
  actorSession: string;
  change: string;
  summary: string | null;
  rig: string;
  targetKind: 'qitem' | 'mission' | 'slice';
  target: string;
}
export interface PulseQueueItem {
  qitemId: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  priority: string;
  tsCreated: string;
  tsUpdated: string;
  body: string;
  summary: string | null;
  blockedOn: string | null;
  handedOffTo: string | null;
  claimedAt: string | null;
}
export interface PulseSeat {
  session: string;
  logicalId: string;
  rigId: string;
  rigName: string;
  podNamespace: string | null;
  terminalActive: boolean | null;
  lastActivityAt: string | null;
}
export interface MaintainedStreamItem {
  streamItemId: string;
  tsEmitted: string;
  streamSortKey: string;
  sourceSession: string;
  body: string;
  format: string;
  hintType: string | null;
  hintUrgency: string | null;
  hintDestination: string | null;
  hintTags: string[] | null;
  interrupt: boolean;
  archivedAt: string | null;
}
const identity = (v: unknown) => isText(v) && v.trim().length > 0;
const textOrNull = nullable(isText);
export const isRecentTransitions = (v: unknown): v is RecentTransition[] => arrayOf(x => hasShape(x, { transitionId: x => isInteger(x) && (x as number) > 0, qitemId: identity, ts: isText, actorSession: isText, change: isText, summary: textOrNull, rig: identity, targetKind: oneOf('qitem', 'mission', 'slice'), target: identity }))(v);
export const isPulseQueueItems = (v: unknown): v is PulseQueueItem[] => arrayOf(x => hasShape(x, { qitemId: identity, sourceSession: identity, destinationSession: identity, state: oneOf('pending', 'in-progress', 'done', 'blocked', 'failed', 'denied', 'canceled', 'handed-off'), priority: oneOf('routine', 'urgent', 'critical'), tsCreated: isText, tsUpdated: isText, body: isText, summary: textOrNull, blockedOn: textOrNull, handedOffTo: textOrNull, claimedAt: textOrNull }))(v);
const isStream = (v: unknown): v is MaintainedStreamItem[] => arrayOf(x => hasShape(x, { streamItemId: identity, streamSortKey: identity, tsEmitted: isText, sourceSession: isText, body: isText, format: isText, hintType: textOrNull, hintUrgency: textOrNull, hintDestination: textOrNull, hintTags: nullable(arrayOf(isText)), interrupt: isBoolean, archivedAt: textOrNull }))(v);
function limitIn(limit: number, max: number) { if (!Number.isInteger(limit) || limit < 1 || limit > max)
  throw new OperatorReadError('invalid_request', `Limit must be an integer from 1 to ${max}.`); }
function requireLocal(scope: OperatorInstanceScope) { const error = operatorScopeState(scope).scopeError; if (error)
  throw error; }
export const recentPulseQueryKey = (scope: OperatorInstanceScope, family: string, ...ids: unknown[]) => ['recent-pulse', ...operatorScopeKey(scope), family, ...ids] as const;
export async function readRecentTransitions(scope: OperatorInstanceScope, filter: RecentScope, limit = 20, options: OperatorReadOptions = {}) {
  requireLocal(scope);
  limitIn(limit, 20);
  if (filter.kind !== 'instance' && (filter.kind !== 'rig' || !identity(filter.rig)))
    throw new OperatorReadError('invalid_request', 'Recent requires instance scope or an exact rig name.');
  const params = new URLSearchParams({ scope: filter.kind, ...(filter.kind === 'rig' ? { rig: filter.rig } : {}), limit: String(limit) });
  return operatorRead(scope, `/api/queue/recent-transitions?${params}`, (v): v is RecentTransition[] => isRecentTransitions(v) && (filter.kind === 'instance' || v.every(row => row.rig === filter.rig)), options);
}
export function freezeRecentSelection(scope: OperatorInstanceScope, rows: readonly RecentTransition[], transitionId: number) {
  requireLocal(scope);
  const row = rows.find(r => r.transitionId === transitionId);
  return row ? Object.freeze({ authorityKey: operatorScopeKey(scope).join('\0'), row: Object.freeze({ ...row }) }) : null;
}
export interface StreamFilter {
  direction?: 'latest' | 'chronological';
  limit?: number;
  afterSortKey?: string;
  sourceSession?: string;
  hintDestination?: string;
  hintTag?: string;
  since?: string;
  until?: string;
  includeArchived?: boolean;
}
export async function readMaintainedStream(scope: OperatorInstanceScope, filter: StreamFilter = {}, options: OperatorReadOptions = {}) {
  requireLocal(scope);
  const limit = filter.limit ?? 5;
  limitIn(limit, 100);
  const direction = filter.direction ?? 'latest';
  if (!['latest', 'chronological'].includes(direction) || (direction === 'latest' && filter.afterSortKey !== undefined))
    throw new OperatorReadError('invalid_request', 'Latest stream reads cannot use a chronological cursor.');
  const params = new URLSearchParams({ direction, limit: String(limit) });
  for (const key of ['afterSortKey', 'sourceSession', 'hintDestination', 'hintTag', 'since', 'until'] as const)
    if (filter[key] !== undefined) {
      if (!identity(filter[key]))
        throw new OperatorReadError('invalid_request', `Stream ${key} must be nonempty.`);
      params.set(key, filter[key]!);
    }
  if (filter.includeArchived)
    params.set('includeArchived', 'true');
  const rows = await operatorRead(scope, `/api/stream/list?${params}`, isStream, options);
  return { rows, direction, limit, nextSortKey: direction === 'chronological' ? rows.at(-1)?.streamSortKey ?? null : null, totalCount: null, possiblyBounded: rows.length >= limit } as const;
}
export const PULSE_LIMITS = { attention: 100, blocked: 100, inProgress: 100, pending: 50, finished: 20 } as const;
export const MAX_PULSE_RIGS = 24;
export const MAX_PULSE_SEATS = 500;
export const MAX_PULSE_BLOCKERS = 24;
export interface PulseWindow<T> {
  rows: T[];
  servedCount: number;
  visibleCount: number;
  totalCount: number | null;
  possiblyBounded: boolean;
}
function windowOf<T>(rows: T[], rawCount: number, limit: number, visible = 5, complete = true): PulseWindow<T> { return { rows: rows.slice(0, visible), servedCount: rows.length, visibleCount: Math.min(rows.length, visible), totalCount: complete && rawCount < limit ? rows.length : null, possiblyBounded: !complete || rawCount >= limit }; }
export interface PulseBlockedItem extends PulseQueueItem {
  blockerSession: string | null;
}
export interface PulseNowRow extends PulseSeat {
  work: PulseQueueItem | null;
  workSourceAvailable: boolean;
}
export interface PulseInputs {
  attention?: PulseQueueItem[];
  blocked?: PulseQueueItem[];
  inProgress?: PulseQueueItem[];
  pending?: PulseQueueItem[];
  finished?: PulseQueueItem[];
  seats?: PulseSeat[];
  blockerOwners?: Record<string, string>;
  inventoryComplete: boolean;
}
export function buildPulseModel(input: PulseInputs) {
  const bySeat = new Map((input.seats ?? []).map(s => [s.session, s]));
  const owners = input.blockerOwners ?? {};
  const blocked = input.blocked?.filter(q => !isHumanSeatSessionRef(q.blockedOn ?? '') && !isHumanSeatSessionRef(owners[q.blockedOn ?? ''] ?? '')).map(q => ({ ...q, blockerSession: owners[q.blockedOn ?? ''] ?? null }));
  // A qitem pointer can resolve to a human owner. Keep raw fallback rows, but
  // do not call their agent-blocked classification complete before enrichment.
  const blockedComplete = (input.blocked ?? []).every(q => !q.blockedOn?.startsWith('qitem-') || isHumanSeatSessionRef(q.blockedOn) || identity(owners[q.blockedOn]));
  const parked = input.inProgress && input.seats ? input.inProgress.filter(q => q.handedOffTo == null && bySeat.get(q.destinationSession)?.terminalActive === false) : undefined;
  const workBySeat = new Map<string, PulseQueueItem>();
  for (const q of input.inProgress ?? [])
    if (!workBySeat.has(q.destinationSession))
      workBySeat.set(q.destinationSession, q);
  const now = input.seats?.filter(s => s.terminalActive === true).map(s => ({ ...s, work: workBySeat.get(s.session) ?? null, workSourceAvailable: input.inProgress !== undefined }));
  const nowComplete = input.inventoryComplete && (input.seats ?? []).every(s => s.terminalActive !== null);
  const parkedComplete = input.inventoryComplete && (input.inProgress ?? []).every(q => q.handedOffTo !== null || typeof bySeat.get(q.destinationSession)?.terminalActive === 'boolean');
  const pending = input.pending?.filter(q => q.claimedAt == null);
  const finished = input.finished?.slice().sort((a, b) => (Date.parse(b.tsUpdated) || 0) - (Date.parse(a.tsUpdated) || 0));
  return {
    waitingYou: input.attention ? windowOf(input.attention, input.attention.length, PULSE_LIMITS.attention) : null,
    blocked: blocked ? windowOf(blocked, input.blocked!.length, PULSE_LIMITS.blocked, 5, blockedComplete) : null,
    parked: parked ? windowOf(parked, input.inProgress!.length, PULSE_LIMITS.inProgress, 5, parkedComplete) : null,
    now: now ? windowOf(now, 0, 1, 5, nowComplete) : null,
    upNext: pending ? windowOf(pending, input.pending!.length, PULSE_LIMITS.pending) : null,
    // A creation-ordered finish window never proves a global completion total.
    finished: finished ? { ...windowOf(finished, input.finished!.length, PULSE_LIMITS.finished), totalCount: null } : null,
  };
}
export type PulseSource<T> = {
  state: 'available';
  data: T;
  readAt: number;
  error: null;
} | {
  state: 'unavailable';
  data: undefined;
  readAt: null;
  error: OperatorReadError;
};
async function source<T>(load: () => Promise<T>): Promise<PulseSource<T>> { try {
  return { state: 'available', data: await load(), readAt: Date.now(), error: null };
}
catch (error) {
  if (error instanceof OperatorReadError && error.code === 'cancelled')
    throw error;
  return { state: 'unavailable', data: undefined, readAt: null, error: error instanceof OperatorReadError ? error : new OperatorReadError('network', 'Pulse source unavailable.') };
} }
export interface PulseRig {
  id: string;
  name?: string | null;
}
export interface PulseNode {
  logicalId: string | null;
  canonicalSessionName?: string | null;
  podNamespace?: string | null;
  nodeKind?: string;
  terminalActive?: boolean | null;
  lastActivityAt?: string | null;
}
const isRigs = (v: unknown): v is PulseRig[] => arrayOf(x => hasShape(x, { id: identity, name: optional(textOrNull) }))(v);
const isNodes = (v: unknown): v is PulseNode[] => arrayOf(x => hasShape(x, { logicalId: nullable(isText), canonicalSessionName: optional(textOrNull), podNamespace: optional(textOrNull), nodeKind: optional(isText), terminalActive: optional(nullable(isBoolean)), lastActivityAt: optional(textOrNull) }))(v);
export async function readPulse(scope: OperatorInstanceScope, options: OperatorReadOptions = {}) {
  requireLocal(scope);
  const entries = await Promise.all((Object.keys(PULSE_LIMITS) as Array<keyof typeof PULSE_LIMITS>).map(async (name) => {
    const params = new URLSearchParams(name === 'attention' ? { attention: '1' } : { state: name === 'inProgress' ? 'in-progress' : name === 'finished' ? 'done,handed-off' : name });
    params.set('limit', String(PULSE_LIMITS[name]));
    return [name, await source(() => operatorRead(scope, `/api/queue/list?${params}`, (v): v is PulseQueueItem[] => isPulseQueueItems(v) && v.length <= PULSE_LIMITS[name] && v.every(row => (name === 'attention' ? ['pending', 'in-progress', 'blocked'] : name === 'inProgress' ? ['in-progress'] : name === 'finished' ? ['done', 'handed-off'] : [name]).includes(row.state)), options))] as const;
  }));
  const sources = Object.fromEntries(entries) as Record<keyof typeof PULSE_LIMITS, PulseSource<PulseQueueItem[]>>;
  const inventory = await source(() => operatorRead(scope, '/api/rigs/summary', isRigs, options));
  const rigs = inventory.data ?? [];
  const targets = rigs.slice(0, MAX_PULSE_RIGS);
  const nodeSources = await Promise.all(targets.map(async (rig) => ({ rig, source: await source(() => operatorRead(scope, `/api/rigs/${encodeURIComponent(rig.id)}/nodes`, isNodes, options)) })));
  const seats: PulseSeat[] = [];
  let truncatedSeatCount = 0;
  for (const { rig, source: read } of nodeSources)
    for (const node of read.data ?? [])
      if (node.nodeKind !== 'infrastructure' && identity(node.canonicalSessionName)) {
        if (seats.length === MAX_PULSE_SEATS) {
          truncatedSeatCount++;
          continue;
        }
        seats.push({ session: node.canonicalSessionName!, logicalId: node.logicalId ?? node.canonicalSessionName!, rigId: rig.id, rigName: rig.name ?? rig.id, podNamespace: node.podNamespace ?? null, terminalActive: node.terminalActive ?? null, lastActivityAt: node.lastActivityAt ?? null });
      }
  const inventoryComplete = inventory.state === 'available' && rigs.length <= MAX_PULSE_RIGS && truncatedSeatCount === 0 && nodeSources.every(n => n.source.state === 'available');
  const allBlockerIds = [...new Set((sources.blocked.data ?? []).map(q => q.blockedOn).filter((id): id is string => !!id && id.startsWith('qitem-') && !isHumanSeatSessionRef(id)))];
  const blockerIds = allBlockerIds.slice(0, MAX_PULSE_BLOCKERS);
  const omittedBlockerIds = allBlockerIds.slice(MAX_PULSE_BLOCKERS);
  const blockerResults = await Promise.all(blockerIds.map(async (id) => [id, await source(() => operatorRead(scope, `/api/queue/${encodeURIComponent(id)}`, (v): v is PulseQueueItem => isPulseQueueItems([v]) && (v as PulseQueueItem).qitemId === id, options))] as const));
  const blockerOwners: Record<string, string> = {};
  const blockerErrors: Record<string, string> = {};
  for (const [id, result] of blockerResults)
    if (result.data)
      blockerOwners[id] = result.data.destinationSession;
    else
      blockerErrors[id] = result.error!.message;
  const input: PulseInputs = { attention: sources.attention.data, blocked: sources.blocked.data, inProgress: sources.inProgress.data, pending: sources.pending.data, finished: sources.finished.data, seats: inventory.state === 'available' ? seats : undefined, blockerOwners, inventoryComplete };
  return { sources, inventory, nodeSources, seats, inventoryComplete, truncatedSeatCount, omittedBlockerIds, truncatedRigCount: Math.max(0, rigs.length - MAX_PULSE_RIGS), blockerErrors, model: buildPulseModel(input), readAt: Date.now() };
}
export type PulseRead = Awaited<ReturnType<typeof readPulse>>;
