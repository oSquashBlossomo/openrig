import { afterEach, expect, it, vi } from 'vitest';
import { buildPulseModel, freezeRecentSelection, readRecentTransitions, readPulse, readMaintainedStream } from '../src/lib/recent-pulse-contracts.js';
import { LOCAL_OPERATOR_INSTANCE as local } from '../src/lib/operator-read.js';
const qitem = (id: string, extra: Record<string, unknown> = {}) => ({ qitemId: id, sourceSession: 'sender@rig', destinationSession: 'owner@rig', state: 'in-progress', priority: 'routine', body: 'work\nmore', summary: null, blockedOn: null, handedOffTo: null, claimedAt: null, tsCreated: '2026-10-04T00:00:00Z', tsUpdated: '2026-10-04T01:00:00Z', ...extra });
const recent = { transitionId: 7, qitemId: 'qitem-original', ts: '2026-10-04T01:00:00Z', actorSession: 'owner@rig', change: 'claimed', summary: null, rig: 'rig', targetKind: 'qitem', target: 'qitem-original' };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('reads bare Recent DTOs and freezes original exact selection', async () => {
  const fetch = vi.fn(async () => Response.json([{ ...recent, rig: 'a / b' }]));
  vi.stubGlobal('fetch', fetch);
  const rows = await readRecentTransitions(local, { kind: 'rig', rig: 'a / b' }, 20);
  expect(fetch.mock.calls[0][0]).toBe('/api/queue/recent-transitions?scope=rig&rig=a+%2F+b&limit=20');
  const selected = freezeRecentSelection(local, rows, 7);
  expect(selected?.row).toEqual({ ...recent, rig: 'a / b' });
  expect(Object.isFrozen(selected?.row)).toBe(true);
  rows[0].change = 'changed';
  expect(selected?.row.change).toBe('claimed');
  expect(freezeRecentSelection(local, rows, 999)).toBeNull();
});
it('never substitutes local reads for a foreign scope', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const remote = { kind: 'remote-instance', hostId: 'foreign' } as const;
  await expect(readRecentTransitions(remote, { kind: 'instance' })).rejects.toMatchObject({ code: 'unsupported_scope' });
  await expect(readPulse(remote)).rejects.toMatchObject({ code: 'unsupported_scope' });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([0, 21, 1.5])('rejects unsupported Recent limit %s', async (limit) => { vi.stubGlobal('fetch', vi.fn()); await expect(readRecentTransitions(local, { kind: 'instance' }, limit)).rejects.toMatchObject({ code: 'invalid_request' }); });
it.each(['headers', 'body'])('bounds Recent %s to five seconds', async (stage) => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(() => stage === 'headers' ? new Promise(() => { }) : Promise.resolve({ ok: true, json: () => new Promise(() => { }), body: null })));
  const promise = readRecentTransitions(local, { kind: 'instance' }).catch(e => e);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await promise).toMatchObject({ code: 'timeout' });
  expect(vi.getTimerCount()).toBe(0);
});
it('joins exact canonical seats and discloses bounded counts without idle inference', () => {
  const seat = (session: string, active: boolean | null) => ({ session, logicalId: session, rigId: 'id', rigName: 'rig', podNamespace: 'pod', terminalActive: active, lastActivityAt: null });
  const model = buildPulseModel({ attention: [qitem('human')], blocked: [qitem('blocked', { state: 'blocked', blockedOn: 'qitem-blocker' }), qitem('human-block', { state: 'blocked', blockedOn: 'human-owner@kernel' })], inProgress: [qitem('work'), qitem('handoff', { destinationSession: 'other@rig', handedOffTo: 'successor' }), qitem('unknown', { destinationSession: 'unknown@rig' })], pending: Array.from({ length: 50 }, (_, i) => qitem(`p${i}`, { state: 'pending' })), finished: Array.from({ length: 20 }, (_, i) => qitem(`f${i}`, { state: 'done', tsUpdated: `2026-10-04T01:${String(i).padStart(2, '0')}:00Z` })), seats: [seat('owner@rig', false), seat('other@rig', false), seat('unknown@rig', null), seat('active@rig', true)], blockerOwners: { 'qitem-blocker': 'exact-blocker@other' }, inventoryComplete: true });
  expect(model.parked.rows.map((r: any) => r.qitemId)).toEqual(['work']);
  expect(model.now.rows.map((r: any) => r.session)).toEqual(['active@rig']);
  expect(model.blocked.rows).toHaveLength(1);
  expect(model.blocked.rows[0].blockerSession).toBe('exact-blocker@other');
  expect(model.upNext).toMatchObject({ servedCount: 50, visibleCount: 5, totalCount: null, possiblyBounded: true });
  expect(model.finished).toMatchObject({ servedCount: 20, visibleCount: 5, totalCount: null });
  expect(model.finished.rows[0].qitemId).toBe('f19');
  expect(model.parked).toMatchObject({ servedCount: 1, totalCount: null });
});
it('separates a failed source from an empty source and keeps unknown blocker pointers', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('attention=1'))
      return Response.json({ error: 'unavailable' }, { status: 503 });
    if (url.includes('state=blocked'))
      return Response.json([qitem('blocked', { state: 'blocked', blockedOn: 'qitem-missing' })]);
    if (url.includes('qitem-missing'))
      return Response.json({ error: 'qitem_not_found' }, { status: 404 });
    return Response.json([]);
  }));
  const read = await readPulse(local);
  expect(read.sources.attention.state).toBe('unavailable');
  expect(read.sources.pending).toMatchObject({ state: 'available', data: [] });
  expect(read.model.waitingYou).toBeNull();
  expect(read.model.upNext?.totalCount).toBe(0);
  expect(read.model.blocked?.rows[0]).toMatchObject({ qitemId: 'blocked', blockedOn: 'qitem-missing', blockerSession: null });
  expect(read.blockerErrors['qitem-missing']).toMatch(/404/);
});
it('uses exact stream cursor and rejects latest plus cursor before transport', async () => {
  const row = { streamItemId: 'id', streamSortKey: 'sort/key', tsEmitted: '2026-10-04T00:00:00Z', sourceSession: 's@rig', body: 'durable', format: 'text', hintType: null, hintUrgency: null, hintDestination: null, hintTags: null, interrupt: false, archivedAt: null };
  const fetch = vi.fn(async () => Response.json([row]));
  vi.stubGlobal('fetch', fetch);
  const page = await readMaintainedStream(local, { direction: 'chronological', limit: 5, afterSortKey: 'sort/key' });
  expect(page.rows).toEqual([row]);
  expect(page.nextSortKey).toBe('sort/key');
  expect(page.totalCount).toBeNull();
  await expect(readMaintainedStream(local, { direction: 'latest', afterSortKey: 'sort/key' })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('bounds inventory and blocker enrichment and reports omitted evidence', async () => {
  let nodeReads = 0, blockerReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('summary'))
      return Response.json(Array.from({ length: 26 }, (_, i) => ({ id: `rig${i}`, name: null })));
    if (url.includes('/nodes')) {
      nodeReads++;
      return Response.json(Array.from({ length: 30 }, (_, i) => ({ logicalId: `owner${i}`, canonicalSessionName: `owner${i}@${url.split('/')[3]}`, terminalActive: true })));
    }
    if (url.includes('state=blocked'))
      return Response.json(Array.from({ length: 30 }, (_, i) => qitem(`blocked${i}`, { state: 'blocked', blockedOn: `qitem-${i}` })));
    if (url.includes('/api/queue/qitem-')) {
      blockerReads++;
      return Response.json(qitem(url.split('/').at(-1)!));
    }
    return Response.json([]);
  }));
  const read = await readPulse(local);
  expect(nodeReads).toBe(24);
  expect(blockerReads).toBe(24);
  expect(read.truncatedRigCount).toBe(2);
  expect(read.truncatedSeatCount).toBe(220);
  expect(read.seats).toHaveLength(500);
  expect(read.inventoryComplete).toBe(false);
  expect(read.model.now?.totalCount).toBeNull();
  expect(read.omittedBlockerIds).toHaveLength(6);
});
it('does not infer exact total from a full pending page after client filtering', () => {
  const pending = Array.from({ length: 50 }, (_, i) => qitem(`p${i}`, { state: 'pending', claimedAt: i < 49 ? '2026-10-04T00:00:00Z' : null }));
  expect(buildPulseModel({ pending, inventoryComplete: false }).upNext).toMatchObject({ servedCount: 1, totalCount: null, possiblyBounded: true });
});
it.each([{ items: [] }, [null], [{ ...recent, qitemId: '' }]])('rejects malformed Recent shape %j without an empty success', async (value) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(value)));
  await expect(readRecentTransitions(local, { kind: 'instance' })).rejects.toMatchObject({ code: 'invalid_contract' });
});
it('rejects rig-mismatched Recent responses', async () => { vi.stubGlobal('fetch', vi.fn(async () => Response.json([recent]))); await expect(readRecentTransitions(local, { kind: 'rig', rig: 'other' })).rejects.toMatchObject({ code: 'invalid_contract' }); });
it('rejects a pending list serving a different state as unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('state=pending') ? [qitem('wrong')] : [])));
  expect((await readPulse(local)).sources.pending.state).toBe('unavailable');
});
it('distinguishes missing work evidence from a successfully read empty owner queue',()=>{
 const seats=[{session:'owner@rig',logicalId:'pod.owner',rigId:'id',rigName:'rig',podNamespace:'pod',terminalActive:true,lastActivityAt:null}];
 expect(buildPulseModel({seats,inventoryComplete:true}).now?.rows[0]).toMatchObject({work:null,workSourceAvailable:false});
 expect(buildPulseModel({seats,inProgress:[],inventoryComplete:true}).now?.rows[0]).toMatchObject({work:null,workSourceAvailable:true});
});
it('does not claim complete active or parked totals when a relevant pane signal is unknown', () => {
  const unknown = { session: 'owner@rig', logicalId: 'pod.owner', rigId: 'id', rigName: 'rig', podNamespace: 'pod', terminalActive: null, lastActivityAt: null };
  const model = buildPulseModel({ seats: [unknown], inProgress: [qitem('work')], inventoryComplete: true });
  expect(model.now).toMatchObject({ servedCount: 0, totalCount: null, possiblyBounded: true });
  expect(model.parked).toMatchObject({ servedCount: 0, totalCount: null, possiblyBounded: true });
});
it.each([{}, {'qitem-blocker': 'human-owner@kernel'}])('leaves an unresolved blocker classification total unknown and excludes a known human owner', owners => {
  const blocked = [qitem('blocked', { state: 'blocked', blockedOn: 'qitem-blocker' })];
  const model = buildPulseModel({ blocked, blockerOwners: owners, inventoryComplete: true });
  if ('qitem-blocker' in owners) {
    expect(model.blocked).toMatchObject({ rows: [], totalCount: 0 });
  } else {
    expect(model.blocked).toMatchObject({ servedCount: 1, totalCount: null, possiblyBounded: true });
    expect(model.blocked?.rows[0].blockedOn).toBe('qitem-blocker');
  }
});
