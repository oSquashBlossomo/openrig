import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fetchNodePreview, fetchSessionPreview, useNodePreview, useSessionPreview } from "../src/hooks/useNodePreview.js";

const clients: QueryClient[] = [];
const payload = (sessionName = "seat@rig") => ({content:"native tail",lines:2,sessionName,capturedAt:"2026-10-04T10:00:00Z"});
function harness() {
  const client = new QueryClient({defaultOptions:{queries:{retry:false,placeholderData:keepPreviousData}}}); clients.push(client);
  return {client,wrapper:({children}:{children:React.ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>};
}
function install(read: (url:string, init?:RequestInit)=>unknown) {
  const fetch=vi.fn(async(url:string, init?:RequestInit)=>url==="/api/config" ? {ok:true,json:async()=>({settings:{"ui.preview.refresh_interval_seconds":{value:60}}})}:read(url,init));
  vi.stubGlobal("fetch",fetch); return fetch;
}
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.clear());vi.unstubAllGlobals();vi.useRealTimers();});
const kinds=["node","session"] as const;
function hook(kind:typeof kinds[number], identity:string|null,paused=false) {return kind==="node"?useNodePreview({rigId:"rig",logicalId:identity,paused}):useSessionPreview({sessionName:identity,paused});}
it.each(kinds)("%s bounds ignored-abort headers to five seconds",async kind=>{
  vi.useFakeTimers();install(()=>new Promise(()=>{}));const {wrapper}=harness();const {result}=renderHook(()=>hook(kind,"seat@rig"),{wrapper});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5001);});expect(result.current.error).toMatchObject({code:"timeout"});
});
it.each(kinds)("%s bounds successful and unavailable response bodies",async kind=>{
  vi.useFakeTimers();const cancel=vi.fn(async()=>{});install(()=>({ok:false,status:503,json:()=>new Promise(()=>{}),body:{cancel}}));
  const {wrapper}=harness();const {result}=renderHook(()=>hook(kind,"seat@rig"),{wrapper});await act(async()=>{await vi.advanceTimersByTimeAsync(5001);});
  expect(result.current.error).toMatchObject({code:"timeout"});expect(cancel).toHaveBeenCalledOnce();
});
it.each(kinds)("%s aborts owned preview body on unmount",async kind=>{
  let started=false;const cancel=vi.fn(async()=>{});const fetch=install(()=>({ok:true,body:{cancel},json:()=>{started=true;return new Promise(()=>{});}}));
  const {wrapper}=harness();const {unmount}=renderHook(()=>hook(kind,"seat@rig"),{wrapper});await waitFor(()=>expect(started).toBe(true));unmount();
  const request=fetch.mock.calls.find(([url])=>url.includes("/preview"));expect(request?.[1]?.signal?.aborted).toBe(true);expect(cancel).toHaveBeenCalledOnce();
});
it.each(kinds)("%s never shows previous entity under a new preview label",async kind=>{
  install(url=>({ok:true,json:()=>url.includes("first")?Promise.resolve(payload("first")):new Promise(()=>{})}));const {wrapper}=harness();
  const {result,rerender}=renderHook(({identity})=>hook(kind,identity),{wrapper,initialProps:{identity:"first"}});await waitFor(()=>expect(result.current.data).toEqual(payload("first")));
  rerender({identity:"second"});expect(result.current.data).toBeUndefined();expect(result.current.isPlaceholderData).toBe(false);
});
it.each(kinds)("%s disabled manual refetch refuses missing identity before GET",async kind=>{
  const fetch=install(()=>({ok:true,json:async()=>payload()}));const {wrapper}=harness();const {result}=renderHook(()=>hook(kind,null),{wrapper});
  let answer:any;await act(async()=>{answer=await result.current.refetch();});expect(fetch.mock.calls.filter(([url])=>url.includes("/preview"))).toHaveLength(0);expect(answer.error).toMatchObject({code:"invalid_request"});
});
it.each(kinds)("%s rejects malformed successful preview before renderer receives it",async kind=>{
  install(()=>({ok:true,json:async()=>({content:{foreign:"not terminal text"},lines:1,sessionName:"seat@rig",capturedAt:"now"})}));const {wrapper}=harness();
  const {result}=renderHook(()=>hook(kind,"seat@rig"),{wrapper});await waitFor(()=>expect(result.current.isError).toBe(true));expect(result.current.error).toMatchObject({code:"invalid_contract"});
});
it("session preview rejects another served session identity",async()=>{
  install(()=>({ok:true,json:async()=>payload("another@rig")}));await expect(fetchSessionPreview("seat@rig",50)).rejects.toMatchObject({code:"invalid_contract"});
});
it("malformed unavailable body preserves fallback rather than throwing on null",async()=>{
  install(()=>({ok:false,status:404,json:async()=>null}));await expect(fetchSessionPreview("seat@rig",50)).resolves.toEqual({unavailable:true,reason:"preview_unavailable"});
});
it.each(kinds)("%s preserves exact keys/last capture while paused and makes no polling GET",async kind=>{
  vi.useFakeTimers();const fetch=install(()=>({ok:true,json:async()=>payload()}));const {client,wrapper}=harness();
  client.setQueryData(kind==="node"?["node-preview","rig","seat@rig",50]:["session-preview","seat@rig",50],payload());
  const {result}=renderHook(()=>hook(kind,"seat@rig",true),{wrapper});await act(async()=>{await vi.advanceTimersByTimeAsync(60001);});
  expect(result.current.data).toEqual(payload());expect(fetch.mock.calls.filter(([url])=>url.includes("/preview"))).toHaveLength(0);
});
it("one request budget includes slow headers plus successful body; late body cannot replace timeout",async()=>{
  vi.useFakeTimers();let headers!:(v:unknown)=>void,body!:(v:unknown)=>void;const cancel=vi.fn(async()=>{});
  install(()=>new Promise(done=>{headers=done;}));const pending=fetchSessionPreview("seat@rig",50).catch(e=>e);
  await vi.advanceTimersByTimeAsync(4000);headers({ok:true,json:()=>new Promise(done=>{body=done;}),body:{cancel}});
  await vi.advanceTimersByTimeAsync(1000);expect(await pending).toMatchObject({code:"timeout"});expect(cancel).toHaveBeenCalledOnce();
  body(payload());await Promise.resolve();expect(vi.getTimerCount()).toBe(0);
});
it.each([404,409,502,503])("node HTTP%s retains served reason/hint unavailable fallback",async status=>{
  install(()=>({ok:false,status,json:async()=>({error:"served_reason",hint:"native hint"})}));
  expect(await fetchNodePreview("rig","seat",50)).toEqual(status===404?{unavailable:true,reason:"served_reason"}:{unavailable:true,reason:"served_reason",hint:"native hint"});
});
it.each([404,502,503])("session HTTP%s retains served reason/hint unavailable fallback",async status=>{
  install(()=>({ok:false,status,json:async()=>({error:"served_reason",hint:"native hint"})}));
  expect(await fetchSessionPreview("seat@rig",50)).toEqual(status===404?{unavailable:true,reason:"served_reason"}:{unavailable:true,reason:"served_reason",hint:"native hint"});
});
it("session409 remains an HTTP error; complete/additive native DTO is returned unchanged",async()=>{
  install(()=>({ok:false,status:409,json:async()=>({error:"conflict"})}));await expect(fetchSessionPreview("seat@rig",50)).rejects.toThrow("HTTP 409");
  const original={...payload(),content:"",lines:0,source:{native:true},future:null};install(()=>({ok:true,json:async()=>original}));expect(await fetchSessionPreview("seat@rig",50)).toBe(original);
});
it("same seat under another rig hides the old capture and cancels a departed rig body",async()=>{
  let finish!:(v:unknown)=>void;const fetch=install(url=>({ok:true,json:()=>url.includes("/first/")?Promise.resolve(payload("first-native")):new Promise(done=>{finish=done;})}));
  const {wrapper}=harness();const {result,rerender,unmount}=renderHook(({rigId})=>useNodePreview({rigId,logicalId:"seat"}),{wrapper,initialProps:{rigId:"first"}});
  await waitFor(()=>expect(result.current.data).toEqual(payload("first-native")));rerender({rigId:"second"});expect(result.current.data).toBeUndefined();
  await waitFor(()=>expect(fetch.mock.calls.filter(([url])=>url.includes("/preview"))).toHaveLength(2));unmount();
  const request=fetch.mock.calls.find(([url])=>url.includes("/second/"));expect(request?.[1]?.signal?.aborted).toBe(true);finish(payload("second-native"));
});
it("missing rig and whitespace session identities refuse transport, including pre-cancelled valid reads",async()=>{
  const fetch=install(()=>({ok:true,json:async()=>payload()}));await expect(fetchNodePreview("","seat",50)).rejects.toMatchObject({code:"invalid_request"});
  await expect(fetchSessionPreview(" \n ",50)).rejects.toMatchObject({code:"invalid_request"});const caller=new AbortController();caller.abort();
  await expect(fetchSessionPreview("seat@rig",50,caller.signal)).rejects.toMatchObject({code:"cancelled"});expect(fetch).not.toHaveBeenCalled();
});
