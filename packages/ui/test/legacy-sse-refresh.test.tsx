import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGlobalEvents } from '../src/hooks/useGlobalEvents.js';
import { useRigSummary } from '../src/hooks/useRigSummary.js';
import { usePsEntries } from '../src/hooks/usePsEntries.js';
import { useRigGraph } from '../src/hooks/useRigGraph.js';
import { useRigEvents } from '../src/hooks/useRigEvents.js';
import { useActivityFeed } from '../src/hooks/useActivityFeed.js';
import { useSliceReview } from '../src/hooks/useReview.js';
import { useSlices } from '../src/hooks/useSlices.js';
import { useMission } from '../src/hooks/useMission.js';
import { useWorkflowSse } from '../src/hooks/useWorkflowSse.js';
import { useWorkflowInstances, workflowQueryKey } from '../src/hooks/useWorkflow.js';
import { LOCAL_OPERATOR_INSTANCE } from '../src/lib/operator-read.js';
import { useAttentionItems } from '../src/hooks/useAttentionItems.js';
let qc:QueryClient;let streams:Map<string,(name:string,payload?:unknown)=>void>;let reads:Array<{url:string,signal?:AbortSignal,completed:boolean}>;
const at='2026-10-04T03:30:00Z';
const workflow={instanceId:'wf-one',workflowName:'workflow',workflowVersion:'v1',createdBySession:'lead@rig',createdAt:at,status:'active',currentFrontier:[],currentStepId:null,hopCount:0,fallbackSynthesis:null,lastContinuationDecision:null,completedAt:null,version:1,resumeCount:0,hopsBaseline:0,deadline:{state:'healthy',evidence:null}};
function setup(){vi.useFakeTimers();vi.setSystemTime(new Date(at));reads=[];streams=new Map();
 vi.stubGlobal('EventSource',class {handlers=new Map<string,any[]>();constructor(url:string){streams.set(url,(name,payload)=>{for(const fn of this.handlers.get(name)??[])fn({data:JSON.stringify(payload)})})}addEventListener(name:string,fn:any){this.handlers.set(name,[...this.handlers.get(name)??[],fn])}close(){}});
 vi.stubGlobal('fetch',vi.fn((url:string,options?:RequestInit)=>{
  const read={url,signal:options?.signal??undefined,completed:false};reads.push(read);
  const body=url==='/api/rigs/summary'?[{id:'rig-one',name:'fresh',nodeCount:1}]:url==='/api/ps'?[{rigId:'rig-one',name:'fresh',nodeCount:1,runningCount:1,status:'running',uptime:null,latestSnapshot:null}]:url.includes('/graph')?{nodes:[],edges:[],fresh:true}:url.startsWith('/api/review')?{slice:'one',fresh:true}:url.startsWith('/api/slices?')?{slices:[],totalCount:0,filter:'all',fresh:true}:url.startsWith('/api/missions')?{missionId:'one',missionPath:'/fixture',slices:[],workflow_spec:null,topology:null,fresh:true}:url.startsWith('/api/workflow/list')?[workflow]:[{qitemId:'fresh'}];
  return new Promise<Response>((resolve,reject)=>{const timer=setTimeout(()=>{read.completed=true;resolve(Response.json(body))},600);read.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'))},{once:true})});
 }));
 qc=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});qc.setQueryData(['hosts'],{ownName:'here',selected:'local',hosts:[]});
 return ({children}:{children:React.ReactNode})=><QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
function event(type:string,rigId='rig-one'){act(()=>streams.get('/api/events')!('message',{type,rigId,qitemId:'q-one'}))}
async function tick(ms:number){await act(async()=>{await vi.advanceTimersByTimeAsync(ms)})}
afterEach(()=>{cleanup();qc?.clear();vi.useRealTimers();vi.unstubAllGlobals()});
it('allows actual summary and ps reads to complete during legacy 150ms windows',async()=>{
 const wrapper=setup();qc.setQueryData(['rigs','summary','local'],[{id:'rig-one',name:'cached',nodeCount:0}]);qc.setQueryData(['ps','local'],[]);
 renderHook(()=>useGlobalEvents(),{wrapper});const summary=renderHook(()=>useRigSummary(),{wrapper});renderHook(()=>usePsEntries(),{wrapper});
 for(let i=0;i<6;i++){event('rig.created');await tick(200)}
 expect(reads.every(r=>!r.signal?.aborted)).toBe(true);expect(summary.result.current.data?.[0]?.name).toBe('fresh');
});
it('retains completed proof reads instead of discarding them under immediate proof events',async()=>{
 const wrapper=setup();qc.setQueryData(['review','slice','one'],{slice:'one',fresh:false});qc.setQueryData(['slices','list','all','all','local'],{slices:[],totalCount:0,filter:'all',fresh:false});qc.setQueryData(['mission','detail','one','local'],{missionId:'one',fresh:false});
 renderHook(()=>useGlobalEvents(),{wrapper});const review=renderHook(()=>useSliceReview('one'),{wrapper});renderHook(()=>useSlices('all'),{wrapper});renderHook(()=>useMission('one'),{wrapper});
 for(let i=0;i<3;i++){event('proof.recorded');await tick(200)}
 // Flush TanStack observer notifications after the 600ms transport settles.
 await tick(1);
 expect(reads.filter(r=>r.completed)).toHaveLength(3);
 expect(review.result.current.data).toMatchObject({fresh:true});
 expect(qc.getQueryData(['slices','list','all','all','local'])).toMatchObject({fresh:true});
 expect(qc.getQueryData(['mission','detail','one','local'])).toMatchObject({fresh:true});
});
it('lets useRigEvents graph reads finish during sustained matching-rig events',async()=>{
 const wrapper=setup();qc.setQueryData(['rig','rig-one','graph','local'],{nodes:[],edges:[],fresh:false});renderHook(()=>useRigEvents('rig-one'),{wrapper});const graph=renderHook(()=>useRigGraph('rig-one'),{wrapper});
 for(let i=0;i<6;i++){event('node.startup_ready');await tick(150)}
 expect(reads.every(r=>!r.signal?.aborted)).toBe(true);expect(graph.result.current.data).toMatchObject({fresh:true});
});
it('coalesces one event across two ActivityFeed subscribers and the matching RigGraph subscriber',async()=>{
 const wrapper=setup();qc.setQueryData(['rig','rig-one','graph','local'],{nodes:[],edges:[],fresh:false});qc.setQueryData(['rig','rig-other','graph','local'],{nodes:[],edges:[],fresh:false});
 renderHook(()=>useGlobalEvents(),{wrapper});renderHook(()=>useActivityFeed(),{wrapper});renderHook(()=>useActivityFeed(),{wrapper});renderHook(()=>useRigEvents('rig-one'),{wrapper});renderHook(()=>useRigGraph('rig-one'),{wrapper});
 event('node.claimed');await tick(150);
 expect(reads).toHaveLength(1);expect(reads[0]!.signal?.aborted).toBe(false);expect(qc.getQueryState(['rig','rig-other','graph','local'])?.isInvalidated).toBe(false);
});
it('coalesces multiple workflow SSE consumers for one workflow event',async()=>{
 const wrapper=setup();qc.setQueryData(workflowQueryKey(LOCAL_OPERATOR_INSTANCE,'instances','all'),[]);renderHook(()=>useWorkflowSse(),{wrapper});renderHook(()=>useWorkflowSse(),{wrapper});renderHook(()=>useWorkflowInstances(),{wrapper});
 act(()=>streams.get('/api/workflow/sse')!('message',{type:'workflow.step_closed',instanceId:'wf-one'}));await tick(150);
 expect(reads).toHaveLength(1);expect(reads[0]!.signal?.aborted).toBe(false);expect(streams.has('/api/workflow/sse')).toBe(true);
});
it('advances actual legacy attention-items reads under queue event bursts',async()=>{
 const wrapper=setup();qc.setQueryData(['attention-items',50,false],{items:[{qitemId:'cached'}],hosts:[]});renderHook(()=>useActivityFeed(),{wrapper});const attention=renderHook(()=>useAttentionItems(),{wrapper});
 for(let i=0;i<3;i++){event('queue.created');await tick(200)}
 await tick(1);
 expect(reads[0]!.completed).toBe(true);expect(attention.result.current.data?.items[0]?.qitemId).toBe('fresh');
});

it('keeps distinct later receipts with equal type, entity and timestamp fields', async () => {
 const wrapper=setup();qc.setQueryData(['rig','rig-one','graph','local'],{nodes:[],edges:[],fresh:false});
 const one=renderHook(()=>useActivityFeed(),{wrapper});const two=renderHook(()=>useActivityFeed(),{wrapper});renderHook(()=>useRigGraph('rig-one'),{wrapper});
 const delivered={type:'node.claimed',rigId:'rig-one',createdAt:at};
 act(()=>streams.get('/api/events')!('message',delivered));await tick(200);
 act(()=>streams.get('/api/events')!('message',delivered));await tick(401);
 expect(reads).toHaveLength(2);expect(reads[0]!.signal?.aborted).toBe(false);
 expect(one.result.current.events).toHaveLength(2);expect(two.result.current.events).toHaveLength(2);
 await tick(601);expect(reads.every(read=>read.completed)).toBe(true);
});
it.each([true,false])('releases only the departing producer lease (surviving producer: %s)', async keepSecond => {
 const wrapper=setup();qc.setQueryData(['rig','rig-one','graph','local'],{nodes:[],edges:[],fresh:false});
 const one=renderHook(()=>useActivityFeed(),{wrapper});const two=renderHook(()=>useActivityFeed(),{wrapper});renderHook(()=>useRigGraph('rig-one'),{wrapper});
 event('node.claimed');await tick(200);event('node.claimed');one.unmount();if(!keepSecond)two.unmount();await tick(401);
 expect(reads).toHaveLength(keepSecond?2:1);expect(reads[0]!.signal?.aborted).toBe(false);
 await tick(601);expect(reads.every(read=>read.completed)).toBe(true);
});
it('drops pending old-rig work when the event observer changes its rig identity', async () => {
 const wrapper=setup();for(const id of ['rig-one','rig-two']){qc.setQueryData(['rig',id,'graph','local'],{nodes:[],edges:[],fresh:false});renderHook(()=>useRigGraph(id),{wrapper})}
 const owner=renderHook(({id})=>useRigEvents(id),{wrapper,initialProps:{id:'rig-one'}});
 event('node.startup_ready');await tick(150);event('node.startup_ready');await tick(150);
 owner.rerender({id:'rig-two'});event('node.startup_ready');event('node.startup_ready','rig-two');await tick(1_000);
 expect(reads.map(read=>read.url)).toEqual(['/api/rigs/rig-one/graph','/api/rigs/rig-two/graph']);
 expect(reads.every(read=>read.completed&&!read.signal?.aborted)).toBe(true);
});
it('preserves opaque rig IDs and host-key membership in global node invalidation', async () => {
 const wrapper=setup();const id='rig:with/slash';const exact=['rig',id,'nodes','remote/name'];const unrelated=['rig','rig','with/slash','remote/name'];
 qc.setQueryData(exact,[]);qc.setQueryData(unrelated,[]);renderHook(()=>useGlobalEvents(),{wrapper});event('node.startup_ready',id);await tick(150);
 expect(qc.getQueryState(exact)?.isInvalidated).toBe(true);expect(qc.getQueryState(unrelated)?.isInvalidated).toBe(false);expect(reads).toHaveLength(0);
});
it('drops pending local workflow work when scope becomes unsupported remote, even for a colliding host name', async () => {
 const wrapper=setup();qc.setQueryData(workflowQueryKey(LOCAL_OPERATOR_INSTANCE,'instances','all'),[]);
 const owner=renderHook(({scope})=>useWorkflowSse(scope),{wrapper,initialProps:{scope:LOCAL_OPERATOR_INSTANCE as {kind:'local-instance'}|{kind:'remote-instance',hostId:string}}});
 renderHook(()=>useWorkflowInstances(),{wrapper});
 act(()=>streams.get('/api/workflow/sse')!('message',{type:'workflow.step_closed'}));await tick(200);
 act(()=>streams.get('/api/workflow/sse')!('message',{type:'workflow.step_closed'}));await tick(200);
 owner.rerender({scope:{kind:'remote-instance',hostId:'local-instance'}});await tick(600);
 expect(reads).toHaveLength(1);expect(reads[0]!.completed).toBe(true);expect(reads[0]!.signal?.aborted).toBe(false);
 expect(owner.result.current.scopeSupported).toBe(false);
});
