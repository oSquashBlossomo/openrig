import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNeedsInputSeats } from "../src/hooks/useNeedsInputSeats.js";
const ps = (rigId: string) => ({ rigId, name: rigId, nodeCount: 1, runningCount: 1, status: 'running', uptime: null, latestSnapshot: null });
const node = (rigId = 'r2', extra: any = {}) => ({ rigId, rigName: rigId, logicalId: 'pod.owner', podId: null, canonicalSessionName: `owner@${rigId}`, nodeKind: 'agent', runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: 'unknown', tmuxAttachCommand: null, resumeCommand: null, latestError: null, terminalActive: null,
  contextUsage: { usedPercentage: null, remainingPercentage: null, contextWindowSize: null, availability: null, sampledAt: null, fresh: false },
  agentActivity: { state: 'needs_input', reason: 'prompt', evidenceSource: 'runtime_hook', sampledAt: '2026-10-04T03:00:00Z', eventAt: null }, ...extra });
let qc: QueryClient;
function setup() { qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); return ({children}: {children: React.ReactNode}) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>; }
const hooks = [['needs-input', useNeedsInputSeats, ['needs-input-seats']]] as const;
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function seats(kind: string, data: any) { return kind === 'context' ? data?.seats : data; }
afterEach(() => { cleanup(); qc?.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });
for (const [kind, useHook, key] of hooks) {
  it(`${kind}: bounds initial inventory headers`, async () => {
    vi.useFakeTimers(); const wrapper = setup(); vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const h = renderHook(() => ({ ...useHook() }), {wrapper}); await tick(5_001);
    expect(h.result.current.isFetching).toBe(false); expect(h.result.current.error).toMatchObject({ code: 'timeout' });
  });
  it(`${kind}: bounds initial inventory body`, async () => {
    vi.useFakeTimers(); const wrapper = setup(); vi.stubGlobal('fetch', vi.fn(async () => ({ok:true,json:()=>new Promise(()=>{}),body:null})));
    const h = renderHook(() => ({ ...useHook() }), {wrapper}); await tick(5_001);
    expect(h.result.current.isFetching).toBe(false); expect(h.result.current.error).toMatchObject({ code: 'timeout' });
  });
  it(`${kind}: a hung first rig cannot hide a healthy later rig`, async () => {
    vi.useFakeTimers(); const wrapper = setup(); const fetch = vi.fn((url: string) => url === '/api/ps' ? Promise.resolve(Response.json([ps('r1'),ps('r2')])) : url.includes('/r1/') ? new Promise<Response>(()=>{}) : Promise.resolve(Response.json([node()]))); vi.stubGlobal('fetch', fetch);
    const h = renderHook(() => ({ ...useHook() }), {wrapper}); await tick(5_002);
    expect(fetch.mock.calls.some(([url]) => url.includes('/r2/'))).toBe(true);
    expect(seats(kind,h.result.current.data)?.[0]).toMatchObject({rigId:'r2',logicalId:'pod.owner'});
  });
  it(`${kind}: cancellation aborts the actual fetch`, async () => {
    const wrapper = setup(); const fetch = vi.fn((_url: string,_init?:RequestInit) => new Promise<Response>(()=>{})); vi.stubGlobal('fetch',fetch);
    renderHook(() => useHook(),{wrapper}); await act(async()=>{await qc.cancelQueries({queryKey:key})}); expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it(`${kind}: partial HTTP failure retains usable seats with explicit failed coverage`, async () => {
    const wrapper=setup(); vi.stubGlobal('fetch',vi.fn(async(url:string)=>url==='/api/ps'?Response.json([ps('r1'),ps('r2')]):url.includes('/r1/')?new Response('unavailable',{status:503}):Response.json([node()])));
    const h=renderHook(()=>({...useHook()}),{wrapper}); await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));
    expect(seats(kind,h.result.current.data)?.[0]).toMatchObject({rigId:'r2'});
    // Current array/FleetData carries no source completeness. Proposed additive
    // hook metadata is intentionally asserted here as an acceptance boundary.
    expect((h.result.current as any).coverage).toMatchObject({complete:false});
  });
  it(`${kind}: refuses a foreign-rig row rather than relabelling it as the requested rig`, async () => {
    const wrapper=setup(); vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url==='/api/ps'?[ps('r1')]:[node('foreign')])));
    const h=renderHook(()=>({...useHook()}),{wrapper}); await waitFor(()=>expect(h.result.current.isFetching).toBe(false));
    expect(seats(kind,h.result.current.data)??[]).toEqual([]);
  });
}
it('needs-input: initial HTTP failure remains unavailable rather than success-empty',async()=>{
  const wrapper=setup();vi.stubGlobal('fetch',vi.fn(async()=>new Response('unavailable',{status:503})));
  const h=renderHook(()=>({...useNeedsInputSeats()}),{wrapper});await waitFor(()=>expect(h.result.current.isFetching).toBe(false));expect(h.result.current.isError).toBe(true);
});
it('needs-input: identity mismatch remains operator attention even when activity says running',async()=>{
  const wrapper=setup();vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url==='/api/ps'?[ps('r2')]:[node('r2',{agentActivity:{state:'running',reason:'working',evidenceSource:'runtime_hook',sampledAt:'2026-10-04T03:00:00Z'},terminalActive:true,identityVerdict:{verdict:'mismatch',reason:'pane belongs to another seat'}})])));
  const h=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toHaveLength(1);
});
it('needs-input: served authoritative needs-input taxonomy outranks legacy activity',async()=>{
  const wrapper=setup();vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url==='/api/ps'?[ps('r2')]:[node('r2',{agentActivity:{state:'running',reason:'working',evidenceSource:'runtime_hook',sampledAt:'2026-10-04T03:00:00Z'},terminalActive:true,activityState:{activity:'working',display:'needs-input',needsInput:{count:1,reason:'approval'},decidedBy:'lifecycle-hooks',seq:1,lastSwap:null}})])));
  const h=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));expect(h.result.current.data).toHaveLength(1);
});
it('control: nullable context/runtime facts and local scope remain truthful with a remote topology selection',async()=>{
  const wrapper=setup();qc.setQueryData(['hosts'],{ownName:'here',selected:'remote',hosts:[]});const fetch=vi.fn(async(url:string)=>Response.json(url==='/api/ps'?[ps('r2')]:[node()]));vi.stubGlobal('fetch',fetch);
  const input=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(input.result.current.isSuccess).toBe(true));
expect(input.result.current.data).toHaveLength(1);
  expect(fetch.mock.calls.map(([url])=>url).every(url=>!url.includes('host='))).toBe(true);
});

import { Hono } from "hono";
import { createDb } from '../../daemon/src/db/connection.js';
import { migrate } from '../../daemon/src/db/migrate.js';
import { ALL_MIGRATIONS } from '../../daemon/src/db/all-migrations.js';
import { RigRepository } from '../../daemon/src/domain/rig-repository.js';
import { SeatIdentityStore } from '../../daemon/src/domain/seat-identity-store.js';
import { SeatActivityService } from '../../daemon/src/domain/seat-activity-service.js';
import { nodesRoutes } from '../../daemon/src/routes/sessions.js';
import { psRoutes } from '../../daemon/src/routes/ps.js';
for (const signal of ['identity', 'taxonomy']) {
  it(`actual daemon nodes DTO ${signal} evidence must survive the active NeedsInput hook`, async () => {
    const db = createDb();
    try {
      migrate(db,ALL_MIGRATIONS); const repo = new RigRepository(db); const rig = repo.createRig('private-needs'); const seat = repo.addNode(rig.id,'pod.owner'); const session = 'pod-owner@private-needs';
      db.prepare("INSERT INTO sessions (id,node_id,session_name,status,startup_status) VALUES ('private-session',?,?,'running','ready')").run(seat.id,session);
      db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('private-binding',?,?,?)").run(seat.id,session,'%private');
      if (signal === 'identity') new SeatIdentityStore(db).upsert({nodeId:seat.id,verdict:'mismatch',evidenceSource:'native_session',reason:'wrong_conversation',evidence:{registeredPane:'%private',observedPid:null,observedCommand:null,matchedLayer:null},sessionName:session,observedAt:new Date().toISOString()} as any);
      const activity = new SeatActivityService({tmux:{readPaneLastActivity:async()=>null},now:()=>new Date(),defaultWindowSeconds:3});
      if(signal==='taxonomy') {
        activity.declareRungInventory({seatNodeId:seat.id,sessionName:session},{adapterId:'private-fixture',runtime:'claude-code',rungs:[{rung:'lifecycle-hooks',lifecycleCoverage:'full',initialTrust:'authoritative'},{rung:'needs-input-chrome',lifecycleCoverage:'full',initialTrust:'authoritative'}]});
        activity.reportEvidence({seatNodeId:seat.id,sessionName:session,rung:'lifecycle-hooks',sourceId:'fixture-hook',seq:1,observedAt:new Date().toISOString(),activity:'working'});
        activity.reportEvidence({seatNodeId:seat.id,sessionName:session,rung:'needs-input-chrome',sourceId:'fixture-chrome',seq:2,observedAt:new Date().toISOString(),needsInput:{count:1,reason:'permission prompt'}});
      }
      const capture = vi.fn(async()=>{throw new Error('No native capture permitted')});
      const app = new Hono(); app.use('*',async(c,next)=>{
        c.set('rigRepo' as never,repo);c.set('tmuxAdapter' as never,{capturePaneContent:capture});
        c.set('agentActivityStore' as never,{getLatestForNode:()=>({state:'running',reason:'working',evidenceSource:'runtime_hook',sampledAt:new Date().toISOString()})});
        c.set('seatActivityService' as never,activity);c.set('psProjectionService' as never,{getEntries:()=>[ps(rig.id)]});await next();
      }); app.route('/api/ps',psRoutes);app.route('/api/rigs/:rigId/nodes',nodesRoutes);
      const body = await (await app.request(`/api/rigs/${rig.id}/nodes?full=true`)).json();expect(body).toHaveLength(1);expect(body[0].agentActivity.state).toBe('running');
      if(signal==='identity')expect(body[0].identityVerdict).toMatchObject({verdict:'mismatch'});else expect(body[0].activityState).toMatchObject({activity:'working',display:'needs-input',needsInput:{count:1,reason:'permission prompt'}});
      expect(capture).not.toHaveBeenCalled();
      const wrapper=setup();vi.stubGlobal('fetch',vi.fn((route:string,init?:RequestInit)=>app.request(route,{method:init?.method,headers:init?.headers})));
      const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));
      expect(hook.result.current.data).toHaveLength(1);
    } finally { cleanup();db.close(); }
  });
}
it('needs-input: malformed per-rig JSON remains explicit unavailable coverage rather than an empty success',async()=>{
  const wrapper=setup();vi.stubGlobal('fetch',vi.fn(async(url:string)=>url==='/api/ps'?Response.json([ps('r2')]):new Response('{')));
  const h=renderHook(()=>({...useNeedsInputSeats()}),{wrapper});await waitFor(()=>expect(h.result.current.isFetching).toBe(false));
  expect(h.result.current.data).toEqual([]);expect((h.result.current as any).coverage).toMatchObject({complete:false});
});
it('needs-input: unobserved activity is unknown coverage rather than proof of no seats needing input',async()=>{
  const wrapper=setup();vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url==='/api/ps'?[ps('r2')]:[node('r2',{agentActivity:null,terminalActive:null})])));
  const h=renderHook(()=>({...useNeedsInputSeats()}),{wrapper});await waitFor(()=>expect(h.result.current.isSuccess).toBe(true));
  expect(h.result.current.data).toEqual([]);expect((h.result.current as any).coverage).toMatchObject({complete:false,unknownSeatCount:1});
});
