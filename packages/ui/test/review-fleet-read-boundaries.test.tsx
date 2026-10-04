import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSliceReview, useMissionReview, useReviewAgents, useRigAgents, type AgentsScope } from "../src/hooks/useReview.js";
import { useFleet } from "../src/hooks/useFleet.js";
const clients: QueryClient[] = [];
function harness() {
  const client = new QueryClient({defaultOptions:{queries:{retry:false,placeholderData:keepPreviousData}}}); clients.push(client);
  return { client, wrapper: ({children}:{children:React.ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
afterEach(() => { cleanup(); clients.splice(0).forEach(c=>c.clear()); vi.unstubAllGlobals(); vi.useRealTimers(); });
const cases = [
  ["slice", () => useSliceReview("one")], ["mission", () => useMissionReview("one")],
  ["agents", () => useReviewAgents("rig")], ["rig", () => useRigAgents()], ["fleet", () => useFleet()],
] as const;
it.each(cases)("%s bounds a successful body even when fetch ignores the timeout signal", async (_name, read) => {
  vi.useFakeTimers(); const cancel=vi.fn(async()=>{}); vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:()=>new Promise(()=>{}),body:{cancel}})));
  const {wrapper}=harness(); const {result}=renderHook(read,{wrapper});
  await act(async()=>{await vi.advanceTimersByTimeAsync(5001);}); expect(result.current.error).toMatchObject({code:"timeout"}); expect(cancel).toHaveBeenCalledOnce();
});
it.each(cases)("%s forwards caller cancellation and cancels the pending body on unmount", async (_name, read) => {
  let started=false; const cancel=vi.fn(async()=>{}); const fetch=vi.fn(async(_url:string,_options?:RequestInit)=>({ok:true,body:{cancel},json:()=>{started=true;return new Promise(()=>{});}})); vi.stubGlobal("fetch",fetch);
  const {wrapper}=harness(); const {unmount}=renderHook(read,{wrapper}); await waitFor(()=>expect(started).toBe(true)); unmount();
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
});
it.each(["slice","mission","agents"])("%s hides previous identity while the new body is pending", async kind=>{
  const original=kind==="agents"?{scope:"slice:one",rows:[],provenance:"source",coordinationHealth:null}:{[kind]:"one",sourceObservation:{state:"available"}};
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce({ok:true,json:async()=>original}).mockResolvedValueOnce({ok:true,json:()=>new Promise(()=>{})}));
  const {wrapper}=harness(); const {result,rerender}=renderHook(({name})=>kind==="slice"?useSliceReview(name):kind==="mission"?useMissionReview(name):useReviewAgents(`slice:${name}`),{wrapper,initialProps:{name:"one"}});
  await waitFor(()=>expect(result.current.data).toEqual(original)); rerender({name:"two"}); expect(result.current.data).toBeUndefined(); expect(result.current.isPlaceholderData).toBe(false);
});
it.each(["slice","mission","agents","fleet"])("%s disabled manual refetch refuses an invalid target/permission", async kind=>{
  const fetch=vi.fn(async()=>({ok:true,json:async()=>({})})); vi.stubGlobal("fetch",fetch); const {wrapper}=harness();
  const {result}=renderHook(()=>kind==="slice"?useSliceReview(null):kind==="mission"?useMissionReview(null):kind==="agents"?useReviewAgents(null):useFleet({enabled:false}),{wrapper});
  let answer:any; await act(async()=>{answer=await result.current.refetch();}); expect(fetch).not.toHaveBeenCalled(); expect(answer.error).toMatchObject({code:"invalid_request"});
});
it.each(["slice","mission","agents"])("%s rejects facts belonging to another selected identity",async kind=>{
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:async()=>kind==="agents"?{scope:"slice:two",rows:[]}:{[kind]:"two"}})));
  const {wrapper}=harness(); const {result}=renderHook(()=>kind==="slice"?useSliceReview("one"):kind==="mission"?useMissionReview("one"):useReviewAgents("slice:one"),{wrapper});
  await waitFor(()=>expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({code:"invalid_contract"});
});
it("fleet refuses malformed host array rather than exposing a crashable composed model",async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:async()=>({rollup:{},hosts:null,needsYou:{items:[]},settled:[]})})));
  const {wrapper}=harness(); const {result}=renderHook(()=>useFleet(),{wrapper}); await waitFor(()=>expect(result.current.isError).toBe(true)); expect(result.current.error).toMatchObject({code:"invalid_contract"});
});
