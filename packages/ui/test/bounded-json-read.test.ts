import { afterEach, expect, it, vi } from "vitest";
import { boundedJsonRead } from "../src/lib/bounded-json-read.js";
import { OperatorReadError } from "../src/lib/operator-read.js";
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("owns one total deadline across slow headers and a callback body which ignores abort",async()=>{
  vi.useFakeTimers(); let headers!:(v:unknown)=>void; const cancel=vi.fn(async()=>{}); const fetch=vi.fn(()=>new Promise(done=>{headers=done;}));vi.stubGlobal("fetch",fetch);
  const pending=boundedJsonRead("/legacy",{readResponse:async response=>({unavailable:true,body:await response.json()})}).catch(e=>e);
  await vi.advanceTimersByTimeAsync(4000);headers({status:503,json:()=>new Promise(()=>{}),body:{cancel}});await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({code:"timeout"});expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it("cancels late headers without decoding them and releases the caller listener",async()=>{
  vi.useFakeTimers();let headers!:(v:unknown)=>void;const caller=new AbortController(),remove=vi.spyOn(caller.signal,"removeEventListener"),cancel=vi.fn(async()=>{}),json=vi.fn();
  vi.stubGlobal("fetch",vi.fn(()=>new Promise(done=>{headers=done;})));const pending=boundedJsonRead("/read",{signal:caller.signal}).catch(e=>e);caller.abort();expect(await pending).toMatchObject({code:"cancelled"});
  headers({body:{cancel},json});await Promise.resolve();await Promise.resolve();expect(cancel).toHaveBeenCalledOnce();expect(json).not.toHaveBeenCalled();expect(remove).toHaveBeenCalledWith("abort",expect.any(Function));expect(vi.getTimerCount()).toBe(0);
});
it("times out ignored header aborts and cancels a later response",async()=>{
  vi.useFakeTimers();let headers!:(v:unknown)=>void;const cancel=vi.fn(async()=>{}),json=vi.fn();vi.stubGlobal("fetch",vi.fn(()=>new Promise(done=>{headers=done;})));
  const pending=boundedJsonRead("/read").catch(e=>e);await vi.advanceTimersByTimeAsync(5000);expect(await pending).toMatchObject({code:"timeout"});headers({body:{cancel},json});await Promise.resolve();await Promise.resolve();expect(cancel).toHaveBeenCalledOnce();expect(json).not.toHaveBeenCalled();
});
it("discards a late body after cancellation, preserving cancellation over decoder rejection",async()=>{
  vi.useFakeTimers();let reject!:(e:unknown)=>void;const caller=new AbortController(),cancel=vi.fn(async()=>{});vi.stubGlobal("fetch",vi.fn(async()=>({ok:true,json:()=>new Promise((_done,fail)=>{reject=fail;}),body:{cancel}})));
  const pending=boundedJsonRead("/read",{signal:caller.signal}).catch(e=>e);await Promise.resolve();await Promise.resolve();caller.abort();expect(await pending).toMatchObject({code:"cancelled"});reject(new SyntaxError("late"));await Promise.resolve();expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it("refuses an already-aborted caller before fetch",async()=>{
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);const caller=new AbortController();caller.abort();await expect(boundedJsonRead("/read",{signal:caller.signal})).rejects.toMatchObject({code:"cancelled"});expect(fetch).not.toHaveBeenCalled();
});
it.each([400,404,500,503])("preserves default HTTP%s Error semantics without waiting for unused body",async status=>{
  const cancel=vi.fn(async()=>{}),json=vi.fn(()=>new Promise(()=>{}));vi.stubGlobal("fetch",vi.fn(async()=>({ok:false,status,body:{cancel},json})));
  const error=await boundedJsonRead("/read").catch(e=>e);expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(OperatorReadError);expect(error.message).toBe(`HTTP ${status}`);expect(json).not.toHaveBeenCalled();expect(cancel).toHaveBeenCalledOnce();
});
it.each([false,true])("distinguishes malformed JSON with custom callback %s",async custom=>{
  vi.stubGlobal("fetch",vi.fn(async()=>new Response("broken")));await expect(boundedJsonRead("/read",custom?{readResponse:r=>r.json()}:{})).rejects.toMatchObject({code:"invalid_json"});
});
it("distinguishes network failures and retains callback domain errors",async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("offline");}));await expect(boundedJsonRead("/read")).rejects.toMatchObject({code:"network",message:"offline"});
  const error=new Error("legacy domain rejection");vi.stubGlobal("fetch",vi.fn(async()=>Response.json({})));await expect(boundedJsonRead("/read",{readResponse:()=>{throw error;}})).rejects.toBe(error);
});
it("retains callback legacy status handling and exact successful/additive objects",async()=>{
  vi.useFakeTimers();const raw={content:null,optional:null,future:{exact:true}};const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>raw}).mockResolvedValueOnce(Response.json({}, {status:404})).mockResolvedValueOnce(Response.json({hint:"setup"},{status:503}));vi.stubGlobal("fetch",fetch);
  expect(await boundedJsonRead("/source?spelling=%2F")).toBe(raw);expect(await boundedJsonRead("/source",{readResponse:r=>r.status===404?null:r.json()})).toBeNull();
  expect(await boundedJsonRead("/source",{readResponse:async r=>r.status===503?{unavailable:true,...await r.json()}:r.json()})).toEqual({unavailable:true,hint:"setup"});expect(vi.getTimerCount()).toBe(0);
  expect(fetch.mock.calls[0][0]).toBe("/source?spelling=%2F");expect(fetch.mock.calls[0][1]).toMatchObject({method:"GET",signal:expect.any(AbortSignal)});expect(fetch.mock.calls[0][1].headers).toBeUndefined();
});
