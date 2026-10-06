import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useNeedsInputSeats } from "../src/hooks/useNeedsInputSeats.js";
import { readNeedsInputSeats } from "../src/lib/needs-input-read.js";

const ps = (rigId: string) => ({ rigId, name: rigId, nodeCount: 1, runningCount: 1, status: "running", uptime: null, latestSnapshot: null });
const node = (rigId: string, extra = {}) => ({ rigId, rigName: rigId, logicalId: "pod.owner", podId: null, canonicalSessionName: `owner@${rigId}`, nodeKind: "agent", runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: "unknown", tmuxAttachCommand: null, resumeCommand: null, latestError: null,
  agentActivity: { state: "needs_input", reason: "prompt", evidenceSource: "runtime_hook", sampledAt: "2026-10-04T03:00:00Z" }, terminalActive: null, ...extra });
const taxonomy = (count = 1) => ({ activity: "working", display: count ? "needs-input" : "working", needsInput: { count, reason: count ? "permission prompt" : null }, decidedBy: "lifecycle-hooks", seq: 1, lastSwap: null });
let qc: QueryClient;
function setup() { qc = new QueryClient({ defaultOptions: { queries: { retry: true, gcTime: Infinity } } }); return ({children}:{children:React.ReactNode}) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>; }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
afterEach(() => { cleanup(); qc?.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("uses one total budget for delayed inventory and a hung node body, retaining healthy peers", async () => {
  vi.useFakeTimers(); const wrapper = setup(); const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn((route: string, init?: RequestInit) => {
    signals.push(init!.signal!);
    if (route === "/api/ps") return new Promise<Response>(resolve => setTimeout(() => resolve(Response.json([ps("hung"), ps("healthy")])), 3_000));
    return Promise.resolve(route.includes("/hung/") ? { ok: true, json: () => new Promise(() => {}), body: null } as Response : Response.json([node("healthy")]));
  }));
  const hook = renderHook(() => ({ ...useNeedsInputSeats() }), { wrapper }); await tick(5_001);
  expect(hook.result.current.isFetching).toBe(false); expect(hook.result.current.readState).toBe("partial");
  expect(hook.result.current.data?.map(s => s.rigId)).toEqual(["healthy"]);
  expect(hook.result.current.sourceErrors[0]).toMatchObject({ rigId: "hung", error: { code: "timeout" } });
  expect(signals[1]!.aborted).toBe(true); expect(signals[2]!.aborted).toBe(false);
});
it("bounds concurrent requests and fairly rotates exact omissions instead of permanently hiding a rig prefix", async () => {
  vi.useFakeTimers(); const wrapper = setup(); const started: string[] = []; let active = 0; let max = 0;
  vi.stubGlobal("fetch", vi.fn((route: string, init?: RequestInit) => {
    if (route === "/api/ps") return Promise.resolve(Response.json(Array.from({length:10},(_,i)=>ps(`rig-${i}`))));
    started.push(route); active++; max = Math.max(max, active);
    init?.signal?.addEventListener("abort",()=>{active--},{once:true}); return new Promise<Response>(()=>{});
  }));
  const hook = renderHook(() => ({ ...useNeedsInputSeats() }), { wrapper }); await tick(5_001);
  expect(started).toHaveLength(4); expect(max).toBe(4); expect(hook.result.current.readState).toBe("unavailable");
  expect(hook.result.current.omittedRigIds).toEqual(["rig-4","rig-5","rig-6","rig-7","rig-8","rig-9"]);
  let next!: Promise<unknown>; act(()=>{next=hook.result.current.refetch()}); await tick(5_001); await next; await tick(1);
  expect(started.slice(4)).toEqual(["/api/rigs/rig-4/nodes?full=true","/api/rigs/rig-5/nodes?full=true","/api/rigs/rig-6/nodes?full=true","/api/rigs/rig-7/nodes?full=true"]);
  expect(max).toBe(4); expect(hook.result.current.omittedRigIds).toEqual(["rig-0","rig-1","rig-2","rig-3","rig-8","rig-9"]);
});
it("reads more than24 fast rigs with deterministic served order and complete coverage", async () => {
  const wrapper = setup(); const rigs = Array.from({length:31},(_,i)=>ps(`rig-${i}`));
  vi.stubGlobal("fetch",vi.fn(async(route:string)=>Response.json(route==='/api/ps'?rigs:[node(route.split('/')[3]!)])));
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));
  expect(hook.result.current.data?.map(s=>s.rigId)).toEqual(rigs.map(r=>r.rigId));expect(hook.result.current.coverage).toMatchObject({complete:true,discoveredRigCount:31,inspectedRigCount:31});expect(hook.result.current.omittedRigIds).toEqual([]);
});
it("preserves valid siblings when a node is malformed/foreign and retains exact nullable additive evidence",async()=>{
  const wrapper=setup();const good={...node('r'),futureFact:{exact:true},contextUsage:null,activityState:null};
  vi.stubGlobal('fetch',vi.fn(async(route:string)=>Response.json(route==='/api/ps'?[ps('r')]:[good,node('foreign'),{...node('r'),logicalId:7}])));
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));
  expect(hook.result.current.data).toHaveLength(1);expect(hook.result.current.data?.[0]?.node).toEqual(good);expect(hook.result.current.sources[0]?.state).toBe('partial');expect(hook.result.current.coverage).toMatchObject({complete:false,rejectedRowCount:2});expect(hook.result.current.sourceErrors).toHaveLength(2);
});
it("zero taxonomy count does not erase an independently observed full=true pane prompt",async()=>{
  const wrapper=setup();const served=node('r',{activityState:taxonomy(0),agentActivity:{state:'needs_input',reason:'selection_prompt',evidenceSource:'pane_heuristic',sampledAt:'2026-10-04T03:00:00Z',fallback:true}});
  vi.stubGlobal('fetch',vi.fn(async(route:string)=>Response.json(route==='/api/ps'?[ps('r')]:[served])));
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));expect(hook.result.current.data?.[0]).toMatchObject({source:'pane_heuristic',node:served});
});
it("taxonomy provenance and identity downrank override unrelated legacy activity timestamps",async()=>{
  const wrapper=setup();const served=node('r',{activityState:taxonomy(),identityVerdict:{verdict:'mismatch',observedAt:'2026-10-04T04:00:00Z',reason:'wrong-seat'}});
  vi.stubGlobal('fetch',vi.fn(async(route:string)=>Response.json(route==='/api/ps'?[ps('r')]:[served])));
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));expect(hook.result.current.data?.[0]).toMatchObject({source:'identity_verdict',eventAt:'2026-10-04T04:00:00Z',node:served});
});
it("does not turn terminal silence with no prompt observation into complete negative coverage",async()=>{
  const wrapper=setup();vi.stubGlobal('fetch',vi.fn(async(route:string)=>Response.json(route==='/api/ps'?[ps('r')]:[node('r',{agentActivity:null,terminalActive:false,activityState:null})])));
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));expect(hook.result.current.data).toEqual([]);expect(hook.result.current.unknownSeats).toHaveLength(1);expect(hook.result.current.readState).toBe('partial');
});
it("caller cancellation rejects a whole read instead of returning partial stale rows, and removes timers/listeners",async()=>{
  vi.useFakeTimers();const controller=new AbortController();const remove=vi.spyOn(controller.signal,'removeEventListener');vi.stubGlobal('fetch',vi.fn(async(route:string)=>route==='/api/ps'?Response.json([ps('r')]):new Promise<Response>(()=>{})));
  const read=readNeedsInputSeats({signal:controller.signal}).catch(e=>e);await tick(1);controller.abort();expect(await read).toMatchObject({code:'cancelled'});expect(vi.getTimerCount()).toBe(0);expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
});
it("observer unmount stops all owned transports and releases the overall deadline",async()=>{
  vi.useFakeTimers();const wrapper=setup();const signals:AbortSignal[]=[];vi.stubGlobal('fetch',vi.fn(async(route:string,init?:RequestInit)=>{signals.push(init!.signal!);return route==='/api/ps'?Response.json([ps('r')]):new Promise<Response>(()=>{})}));
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await tick(1);hook.unmount();await tick(1);expect(signals[1]!.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it("a failed refresh keeps last observed seats with stale readState and can recover to a truthful empty read",async()=>{
  const wrapper=setup();const fetch=vi.fn(async(route:string)=>Response.json(route==='/api/ps'?[ps('r')]:[node('r')]));vi.stubGlobal('fetch',fetch);
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));const readAt=hook.result.current.readAt;
  fetch.mockImplementation(async()=>new Response('unavailable',{status:503}));await act(async()=>{await hook.result.current.refetch()});await waitFor(()=>expect(hook.result.current.readState).toBe('stale'));expect(hook.result.current.data).toHaveLength(1);expect(hook.result.current.readAt).toBe(readAt);
  fetch.mockImplementation(async()=>Response.json([]));await act(async()=>{await hook.result.current.refetch()});await waitFor(()=>expect(hook.result.current.readState).toBe('ready'));expect(hook.result.current.data).toEqual([]);expect(hook.result.current.coverage?.complete).toBe(true);
});
it("retains exact local key and cadence while overriding inherited retries and previous placeholders",async()=>{
  const wrapper=setup();const fetch=vi.fn(async()=>new Response('unavailable',{status:503}));vi.stubGlobal('fetch',fetch);
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(hook.result.current.isError).toBe(true));const query=qc.getQueryCache().find({queryKey:['needs-input-seats'],exact:true});expect(query?.options).toMatchObject({retry:false,staleTime:5000,refetchInterval:10000});expect(query?.options.placeholderData).toBeUndefined();expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects contradictory served taxonomy instead of claiming complete no-input coverage',async()=>{
  const wrapper=setup();const served=node('r',{agentActivity:{state:'running',reason:'working',evidenceSource:'runtime_hook',sampledAt:'2026-10-04T03:00:00Z'},activityState:{...taxonomy(),display:'working'}});
  vi.stubGlobal('fetch',vi.fn(async(route:string)=>Response.json(route==='/api/ps'?[ps('r')]:[served])));
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});await waitFor(()=>expect(hook.result.current.isSuccess).toBe(true));expect(hook.result.current.coverage?.complete).toBe(false);expect(hook.result.current.sourceErrors[0]?.error).toMatchObject({code:'invalid_contract'});
});
it('retains old same-key legacy array cache as stale evidence during a new bounded read',async()=>{
  vi.useFakeTimers();const wrapper=setup();const cached=[{rigId:'r',logicalId:'pod.owner',sessionName:'owner@r',source:'hook'}];qc.setQueryData(['needs-input-seats'],cached);vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(()=>{})));
  const hook=renderHook(()=>useNeedsInputSeats(),{wrapper});expect(hook.result.current.data).toEqual(cached);expect(hook.result.current.readState).toBe('stale');expect(hook.result.current.coverage).toBeUndefined();let pending!:Promise<unknown>;act(()=>{pending=hook.result.current.refetch()});await tick(5_001);await pending;await tick(1);expect(hook.result.current.readState).toBe('stale');expect(hook.result.current.error).toMatchObject({code:'timeout'});
});
