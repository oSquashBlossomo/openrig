import { afterEach, expect, it, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { buildTopologyLink, parseTopologyLocation } from "../src/lib/topology-location.js";
import { parseTopologySearch, stringifyTopologySearch } from "../src/lib/topology-search.js";
import { readNodeDetail } from "../src/lib/node-library-reads.js";
const routers:Array<ReturnType<typeof createRouter>>=[];
function routerAt(href:string,adapter=true) {
  const root=createRootRoute();const routes=["/topology","/topology/rig/$rigId","/topology/pod/$rigId/$podName","/topology/seat/$rigId/$logicalId","/unrelated"].map(path=>createRoute({getParentRoute:()=>root,path}));
  const router=createRouter({routeTree:root.addChildren(routes),history:createMemoryHistory({initialEntries:[href]}),...(adapter?{parseSearch:parseTopologySearch,stringifySearch:stringifyTopologySearch}:{})});
  routers.push(router as any);return router;
}
afterEach(()=>{routers.splice(0).forEach(router=>router.history.destroy());vi.unstubAllGlobals();});
it.each(["1.0","1","9007199254740993","001","true","null"," space ","日本語🙂","%","%2F","/","?","#"])("real parseLocation preserves all four raw search fields %s",async value=>{
  const fields={sourceHost:value,selectedRig:value,selectedNode:value,spatialQuery:value};const href="/topology?"+new URLSearchParams(fields);
  const router=routerAt(href);await router.load();expect(router.state.location.search).toMatchObject(fields);
  const parsed=parseTopologyLocation({kind:"host"},router.state.location.search);expect(parsed.location).toMatchObject({sourceHost:value,spatialQuery:value,selection:{rigId:value,nodeId:value}});
  const second=routerAt(router.state.location.href);await second.load();expect(second.state.location.search).toMatchObject(fields);
});
it.each(["sourceHost=%GG","sourceHost=%E0%A4%A","sourceHost=%ED%A0%80","sourceHost=local&sourceHost=local"])("real canonicalization never erases invalid source %s",async query=>{
  const router=routerAt("/topology?"+query);await router.load();expect(parseTopologyLocation({kind:"host"},router.state.location.search).targetValid).toBe(false);
  const reloaded=routerAt(router.state.location.href);await reloaded.load();expect(parseTopologyLocation({kind:"host"},reloaded.state.location.search).sourceState).toBe("invalid");
});
it.each(["boolean=true&count=1&decimal=1.0&nil=null","array=%5B1%2C%22x%22%5D&object=%7B%22a%22%3Atrue%7D","query=%22quoted%22&query=plain&empty=&unknown=%GG"])("unrelated query stays byte/semantically compatible with defaults: %s",async query=>{
  expect(parseTopologySearch("?"+query)).toEqual(defaultParseSearch("?"+query));expect(stringifyTopologySearch(defaultParseSearch("?"+query))).toBe(defaultStringifySearch(defaultParseSearch("?"+query)));
  const custom=routerAt("/unrelated?"+query),native=routerAt("/unrelated?"+query,false);await Promise.all([custom.load(),native.load()]);expect(custom.state.location.searchStr).toBe(native.state.location.searchStr);expect(custom.state.location.search).toEqual(native.state.location.search);
});
it("original publicHref retains an oversized input even when unrelated default JSON canonicalization shrinks href",async()=>{
  const input="/topology?sourceHost=local&unrelated="+"1"+"0".repeat(17000);
  const router=routerAt(input);await router.load();expect(router.state.location.publicHref).toBe(input);
  expect(router.state.location.href.length).toBeLessThan(100);
  const parsed=parseTopologyLocation({kind:"host"},router.state.location.search,{serializedPathAndQuery:router.state.location.publicHref});
  expect(parsed).toMatchObject({targetValid:false,issues:[{field:"location",code:"too_large",blocking:true}]});
});
it.each(["1.0","9007199254740993","001","true","null"," space ","日本語🙂","%","%2F","/","?","#"])("raw router params and the actual node reader round-trip exact identity %s",async value=>{
  const result=buildTopologyLink({scope:{kind:"seat",rigId:value,logicalId:value},sourceHost:"local"});expect(result.ok).toBe(true);if(!result.ok)return;
  const router=routerAt(result.target.href);await router.load();const params=router.state.matches.at(-1)!.params as {rigId:string;logicalId:string};expect(params).toEqual({rigId:value,logicalId:value});
  const built=router.buildLocation({to:result.target.to,params:result.target.params,search:result.target.search} as any);expect(built.href).toBe(result.target.href);
  const node={...params,rigName:"Fixture",podId:null,canonicalSessionName:null,nodeKind:"agent",runtime:null,sessionStatus:null,startupStatus:null,restoreOutcome:"unknown",tmuxAttachCommand:null,resumeCommand:null,recoveryGuidance:null,latestError:null,model:null,agentRef:null,profile:null,resolvedSpecName:null,resolvedSpecVersion:null,cwd:null,startupFiles:[],startupActions:[],recentEvents:[],infrastructureStartupCommand:null,peers:[],edges:{outgoing:[],incoming:[]},transcript:{enabled:false,path:null,tailCommand:null},compactSpec:{name:null,version:null,profile:null,skillCount:0,guidanceCount:0}};
  const fetch=vi.fn(async(_input: RequestInfo | URL, _init?: RequestInit)=>Response.json(node));vi.stubGlobal("fetch",fetch);expect(await readNodeDetail(params.rigId,params.logicalId,"local")).toEqual(node);
  expect(fetch.mock.calls[0]?.[0]).toBe(`/api/rigs/${encodeURIComponent(value)}/nodes/${encodeURIComponent(value)}`);
});
it("real push/back and same-route replace restore semantic URL, preserving unrelated hash/state and one drill entry",async()=>{
  const source=buildTopologyLink({scope:{kind:"host"},sourceHost:"A",view:"spatial",spatialMode:"list",spatialQuery:" last character ",selection:{rigId:"r",nodeId:"graph-id"}});expect(source.ok).toBe(true);if(!source.ok)return;
  const router=routerAt(source.target.href+"#unrelated");await router.load();await router.navigate({to:"/topology",search:{...source.target.search,spatialQuery:" newest "},replace:true,hash:"unrelated",state:{visit:"fixture"},resetScroll:false} as any);
  const origin=router.state.location.href;const destination=buildTopologyLink({scope:{kind:"seat",rigId:"r",logicalId:"logical/id"},sourceHost:"A"});if(!destination.ok)throw Error("missing target");
  await router.navigate({...destination.target,state:{visit:"detail"},resetScroll:false} as any);expect(router.history.location.state.__TSR_index).toBe(1);
  router.history.back();await router.load();expect(router.state.location.href).toBe(origin);expect(router.state.location.hash).toBe("unrelated");expect(router.state.location.state).toMatchObject({visit:"fixture"});
  expect(parseTopologyLocation({kind:"host"},router.state.location.search).location).toMatchObject({sourceHost:"A",view:"spatial",spatialMode:"list",spatialQuery:" newest ",selection:{rigId:"r",nodeId:"graph-id"}});
  router.history.forward();await router.load();expect(router.state.location.pathname).toBe("/topology/seat/r/logical%2Fid");
});
it("existing manual preencode/decode convention needs coordinated migration",async()=>{
  const value="%2F";const router=routerAt("/topology");await router.load();
  await router.navigate({to:"/topology/seat/$rigId/$logicalId",params:{rigId:"r",logicalId:encodeURIComponent(value)}} as any);
  const legacy=(router.state.matches.at(-1)!.params as any).logicalId;expect(legacy).toBe(encodeURIComponent(value));expect(decodeURIComponent(legacy)).toBe(value);
  const result=buildTopologyLink({scope:{kind:"seat",rigId:"r",logicalId:value},sourceHost:"local"});if(!result.ok)throw Error("missing target");await router.navigate(result.target as any);
  const raw=(router.state.matches.at(-1)!.params as any).logicalId;expect(raw).toBe(value);expect(decodeURIComponent(raw)).toBe("/");
});
