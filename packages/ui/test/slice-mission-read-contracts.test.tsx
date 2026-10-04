import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { keepPreviousData, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { useSlices, useSliceDetail, useSliceDoc, useSliceDetails, useQueueItemMap, type SliceDetail } from '../src/hooks/useSlices.js';
import { useMission } from '../src/hooks/useMission.js';
import { LOCAL_OPERATOR_INSTANCE } from '../src/lib/operator-read.js';
const slice: SliceDetail = {name:'one',missionId:'mission',slicePath:'/ws/mission/slices/one',displayName:'One',railItem:null,status:'active',rawStatus:null,qitemIds:[],commitRefs:[],lastActivityAt:null,workflowBinding:null,story:{events:[],phaseDefinitions:null},acceptance:{totalItems:0,doneItems:0,percentage:0,items:[],closureCallout:null,currentStep:null},decisions:{rows:[]},docs:{tree:[]},tests:{proofPackets:[],aggregate:{passCount:0,failCount:0}},topology:{affectedRigs:[],totalSeats:0,specGraph:null}};
const mission={missionId:'mission',missionPath:'/ws/mission',slices:[],workflow_spec:null,topology:null,status:null,additive:{exact:true}};
const list={filter:'all',slices:[],totalCount:0,boundToWorkflow:null};
const doc={relPath:'docs/exact.md',content:''};
const clients:QueryClient[]=[];
function harness(host='local') { const client=new QueryClient({defaultOptions:{queries:{retry:false,placeholderData:keepPreviousData}}});clients.push(client);client.setQueryData(['hosts'],{ownName:'test',selected:host,hosts:[]});return {client,wrapper:({children}:PropsWithChildren)=><QueryClientProvider client={client}>{children}</QueryClientProvider>}; }
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.clear());vi.useRealTimers();vi.unstubAllGlobals();});
type Read='list'|'slice'|'doc'|'mission';
function payload(read:Read) { return read==='list'?list:read==='slice'?slice:read==='doc'?doc:mission; }
function useRead(read:Read,id:string|null='one') { return read==='list'?useSlices('all'):read==='slice'?useSliceDetail(id):read==='doc'?useSliceDoc(id,'docs/exact.md'):useMission(id==='one'?'mission':id); }
describe('legacy slice/mission bounded read identity',()=>{
 it.each<Read>(['list','slice','doc','mission'])('drops old %s data when host changes under global keepPreviousData',async read=>{
  const fetch=vi.fn().mockResolvedValueOnce(Response.json(payload(read))).mockImplementation(()=>new Promise(()=>{}));vi.stubGlobal('fetch',fetch);const {client,wrapper}=harness();const {result}=renderHook(()=>useRead(read),{wrapper});await waitFor(()=>expect(result.current.data).toEqual(payload(read)));
  act(()=>client.setQueryData(['hosts'],{ownName:'test',selected:'remote/exact',hosts:[]}));await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));expect(result.current.data).toBeUndefined();expect(result.current.isPlaceholderData).toBe(false);expect(fetch.mock.calls[1][0]).toContain('host=remote%2Fexact');
 });
 it.each<Read>(['slice','doc','mission'])('drops old %s data on target change',async read=>{
  const fetch=vi.fn().mockResolvedValueOnce(Response.json(payload(read))).mockImplementation(()=>new Promise(()=>{}));vi.stubGlobal('fetch',fetch);const {wrapper}=harness();const {result,rerender}=renderHook(({id})=>useRead(read,id),{wrapper,initialProps:{id:'one'}});await waitFor(()=>expect(result.current.data).toEqual(payload(read)));rerender({id:'two'});await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));expect(result.current.data).toBeUndefined();
 });
 it.each<Read>(['list','slice','doc','mission'])('bounds never-resolving %s body and cleans it',async read=>{
  vi.useFakeTimers();const cancel=vi.fn(async()=>{});const fetch=vi.fn(async()=>({ok:true,status:200,json:()=>new Promise(()=>{}),body:{cancel}}));vi.stubGlobal('fetch',fetch);const {wrapper}=harness();const {result}=renderHook(()=>useRead(read),{wrapper});await act(async()=>{await vi.advanceTimersByTimeAsync(5001)});expect(result.current.error).toMatchObject({code:'timeout'});expect(cancel).toHaveBeenCalledOnce();
 });
 it.each<Read>(['list','slice','doc','mission'])('observer cancellation aborts %s and disposes late response',async read=>{
  let resolve!:(v:unknown)=>void;const json=vi.fn(),cancel=vi.fn(async()=>{});const fetch=vi.fn((_url:string,_opts?:RequestInit)=>new Promise(done=>{resolve=done}));vi.stubGlobal('fetch',fetch);const {wrapper}=harness();const hook=renderHook(()=>useRead(read),{wrapper});await waitFor(()=>expect(fetch).toHaveBeenCalledOnce());hook.unmount();expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);await act(async()=>{resolve({json,body:{cancel}})});expect(cancel).toHaveBeenCalledOnce();expect(json).not.toHaveBeenCalled();
 });
 it.each<Read>(['slice','doc','mission'])('disabled %s selection blocks manual refetch',async read=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);const {wrapper}=harness();const {result}=renderHook(()=>useRead(read,null),{wrapper});await act(async()=>{await result.current.refetch()});expect(fetch).not.toHaveBeenCalled();await waitFor(()=>expect(result.current.error).toMatchObject({code:'invalid_request'}));
 });
 it.each<Read>(['list','slice','doc','mission'])('rejects wrong served %s identity',async read=>{
  const wrong=read==='list'?{...list,filter:'active'}:read==='slice'?{...slice,name:'other'}:read==='doc'?{...doc,relPath:'other.md'}:{...mission,missionId:'other'};vi.stubGlobal('fetch',vi.fn(async()=>Response.json(wrong)));const {wrapper}=harness();const {result}=renderHook(()=>useRead(read),{wrapper});await waitFor(()=>expect(result.current.isError).toBe(true));expect(result.current.error).toMatchObject({code:'invalid_contract'});expect(result.current.data).toBeUndefined();
 });
 it('preserves exact doc filename reserved characters in URL and response',async()=>{
  const relPath='docs/why?exact#v1%.md';const fetch=vi.fn(async(_url:string)=>Response.json({relPath,content:''}));vi.stubGlobal('fetch',fetch);const {wrapper}=harness('remote/exact');const {result}=renderHook(()=>useSliceDoc('one',relPath),{wrapper});await waitFor(()=>expect(result.current.isSuccess).toBe(true));expect(fetch.mock.calls[0][0]).toBe('/api/slices/one/doc/docs/why%3Fexact%23v1%25.md?host=remote%2Fexact');expect(result.current.data?.content).toBe('');
 });
 it('bounds detail maps including queue bodies without converting errors into absent IDs',async()=>{
  vi.useFakeTimers();vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:()=>new Promise(()=>{})})));const {wrapper}=harness();const details=renderHook(()=>useSliceDetails(['one','one','']),{wrapper});const items=renderHook(()=>useQueueItemMap(['q:exact','q:exact','']),{wrapper});await act(async()=>{await vi.advanceTimersByTimeAsync(5001)});expect(details.result.current.isFetching).toBe(false);expect(details.result.current.missingNames).toEqual(['one']);expect(items.result.current.isFetching).toBe(false);expect(items.result.current.missingIds).toEqual([]);
 });
 it('retains same-target additive/null facts and canonical polling keys',async()=>{
  const fetch=vi.fn(async(url:string)=>Response.json(url.includes('/missions/')?mission:doc));vi.stubGlobal('fetch',fetch);const {client,wrapper}=harness();const m=renderHook(()=>useMission('mission'),{wrapper});const d=renderHook(()=>useSliceDoc('one','docs/exact.md'),{wrapper});await waitFor(()=>expect(m.result.current.data).toEqual(mission));await waitFor(()=>expect(d.result.current.data).toEqual(doc));expect(client.getQueryData(['mission','detail','mission','local'])).toEqual(mission);expect(client.getQueryData(['slices','doc','one','docs/exact.md','local'])).toEqual(doc);
 });
});

describe('scope and status preservation',()=>{
 it('explicit remote queue scope suppresses warm local bytes and GET; aggregate default stays local',async()=>{
  const q={qitemId:'q:exact',body:'LOCAL BYTES',tier:null,tags:null,summary:null};const fetch=vi.fn(async()=>Response.json(q));vi.stubGlobal('fetch',fetch);const {client,wrapper}=harness('remote/exact');client.setQueryData(['queue','item','q:exact'],q);
  const remote=renderHook(()=>useQueueItemMap(['q:exact'],{kind:'remote-instance',hostId:'remote/exact'}),{wrapper});expect(remote.result.current.itemsById.size).toBe(0);expect(remote.result.current.scopeSupported).toBe(false);expect(remote.result.current.scopeError).toMatchObject({code:'unsupported_scope'});expect(fetch).not.toHaveBeenCalled();
  const aggregate=renderHook(()=>useQueueItemMap(['q:exact']),{wrapper});await waitFor(()=>expect(aggregate.result.current.itemsById.get('q:exact')).toEqual(q));expect(aggregate.result.current.scopeSupported).toBe(true);
 });
 it('an explicit local queue viewer drops data immediately when its scope changes',async()=>{
  const q={qitemId:'q:exact',body:'LOCAL BYTES'};vi.stubGlobal('fetch',vi.fn(async()=>Response.json(q)));const {wrapper}=harness();const {result,rerender}=renderHook(({scope})=>useQueueItemMap(['q:exact'],scope),{wrapper,initialProps:{scope:LOCAL_OPERATOR_INSTANCE as typeof LOCAL_OPERATOR_INSTANCE|{kind:'remote-instance',hostId:string}}});await waitFor(()=>expect(result.current.itemsById.size).toBe(1));rerender({scope:{kind:'remote-instance',hostId:'local-instance'}});expect(result.current.itemsById.size).toBe(0);expect(result.current.scopeSupported).toBe(false);
 });
 it('colon-bearing workflow pairs keep separate cache identities and exact request bytes',async()=>{
  const fetch=vi.fn(async(url:string)=>{const p=new URL(url,'http://fixture.local').searchParams;return Response.json({...list,boundToWorkflow:{specName:p.get('boundToWorkflowName'),specVersion:p.get('boundToWorkflowVersion'),matched:0,total:0}})});vi.stubGlobal('fetch',fetch);const {client,wrapper}=harness();const {result,rerender}=renderHook(({name,version})=>useSlices('all',{specName:name,specVersion:version}),{wrapper,initialProps:{name:'flow:part',version:'v1'}});await waitFor(()=>expect(result.current.isSuccess).toBe(true));rerender({name:'flow',version:'part:v1'});await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));await waitFor(()=>expect(result.current.isSuccess).toBe(true));expect(client.getQueryData(['slices','list','all',['workflow','flow:part','v1'],'local'])).toMatchObject({boundToWorkflow:{specName:'flow:part',specVersion:'v1'}});expect(client.getQueryData(['slices','list','all',['workflow','flow','part:v1'],'local'])).toMatchObject({boundToWorkflow:{specName:'flow',specVersion:'part:v1'}});
 });
 it.each(['list','mission'] as const)('retains %s503 hint and bounds its body',async read=>{
  const fetch=vi.fn(async()=>Response.json({error:'slices_root_not_configured',hint:'exact setup'},{status:503}));vi.stubGlobal('fetch',fetch);const {wrapper}=harness();const {result}=renderHook(()=>useRead(read),{wrapper});await waitFor(()=>expect(result.current.data).toEqual({unavailable:true,error:'slices_root_not_configured',hint:'exact setup'}));
  vi.useFakeTimers();fetch.mockImplementation(async()=>({status:503,ok:false,json:()=>new Promise(()=>{})}) as any);const hanging=renderHook(()=>useRead(read),{wrapper:harness().wrapper});await act(async()=>{await vi.advanceTimersByTimeAsync(5001)});expect(hanging.result.current.error).toMatchObject({code:'timeout'});
 });
 it.each(['list','slice','doc','mission'] as const)('one total header/body deadline owns %s',async read=>{
  vi.useFakeTimers();const cancel=vi.fn(async()=>{});vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true,status:200,json:()=>new Promise(()=>{}),body:{cancel}}),4000))));const {wrapper}=harness();const {result}=renderHook(()=>useRead(read),{wrapper});await act(async()=>{await vi.advanceTimersByTimeAsync(5001)});expect(result.current.error).toMatchObject({code:'timeout'});expect(cancel).toHaveBeenCalledOnce();
 });
 it('queue errors stay distinguishable from actual missing items',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('missing')?Response.json({error:'qitem_not_found'},{status:404}):Response.json({qitemId:'WRONG',body:'other'})));const {wrapper}=harness();const {result}=renderHook(()=>useQueueItemMap(['missing','wrong']),{wrapper});await waitFor(()=>expect(result.current.isFetching).toBe(false));expect(result.current.missingIds).toEqual(['missing']);expect(result.current.itemsById.size).toBe(0);expect(result.current.errorsById?.get('wrong')).toMatchObject({code:'invalid_contract'});
 });
});
