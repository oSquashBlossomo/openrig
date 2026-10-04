// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { boundedJsonRead } from "../src/lib/bounded-json-read.js";
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it.each(["unavailable","domain-error","default-http-error"])("disposes unread native stream after %s without changing its result/error",async mode=>{
  const cancel=vi.fn();const body=new ReadableStream({cancel});vi.stubGlobal("fetch",vi.fn(async()=>new Response(body,{status:404})));const domainError=new Error("missing target");
  if(mode==="unavailable")expect(await boundedJsonRead("/private-fixture",{readResponse:()=>null})).toBeNull();
  else if(mode==="domain-error")await expect(boundedJsonRead("/private-fixture",{readResponse:()=>{throw domainError;}})).rejects.toBe(domainError);
  else await expect(boundedJsonRead("/private-fixture")).rejects.toThrow("HTTP 404");
  expect(cancel).toHaveBeenCalledOnce();
});
it("does not double-cancel an unread body when callback settles after caller abort",async()=>{
  vi.useFakeTimers();const cancel=vi.fn(),caller=new AbortController();let finish!:(v:null)=>void;const body=new ReadableStream({cancel});vi.stubGlobal("fetch",vi.fn(async()=>new Response(body)));
  const pending=boundedJsonRead("/read",{signal:caller.signal,readResponse:()=>new Promise<null>(done=>{finish=done;})}).catch(e=>e);
  await Promise.resolve();await Promise.resolve();caller.abort();expect(await pending).toMatchObject({code:"cancelled"});finish(null);await Promise.resolve();await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
