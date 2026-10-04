import { expect, it } from "vitest";
import { buildTopologyLink, parseTopologyLocation, topologySelectionMatches, type TopologyScope } from "../src/lib/topology-location.js";
import { parseTopologySearch, stringifyTopologySearch } from "../src/lib/topology-search.js";
const host: TopologyScope = { kind: "host" };
const parse = (search: string, scope: TopologyScope = host) => parseTopologyLocation(scope, parseTopologySearch(search));
it.each(["1.0","1","9007199254740993","001","true","null"," spaces ","日本語🙂","%","%2F","/","?","#"])("builder preserves exact opaque identities/search %s",value=>{
  const link=buildTopologyLink({scope:host,sourceHost:value,view:"spatial",spatialQuery:value,selection:{rigId:value,nodeId:value}});
  expect(link.ok).toBe(true);if(!link.ok)return;const decoded=String(link.target.href.split("?")[1]);
  const params=new URLSearchParams(decoded);expect(params.get("sourceHost")).toBe(value);expect(params.get("selectedNode")).toBe(value);
  expect(parse("?"+decoded).location).toMatchObject({sourceHost:value,spatialQuery:value,selection:{rigId:value,nodeId:value}});
});
it("defaults are route-aware; non-seat view changes retain query/selection and seat discards spatial fields",()=>{
  expect(parse("").location.view).toBe("graph");expect(parse("",{kind:"seat",rigId:"r",logicalId:"l"}).location.view).toBe("overview");
  const search="?sourceHost=local&view=table&spatialMode=list&spatialQuery= editor &selectedRig=r&selectedNode=graph-id";
  expect(parse(search).location).toMatchObject({view:"table",spatialMode:"list",spatialQuery:" editor ",selection:{rigId:"r",nodeId:"graph-id"}});
  const seat=parse(search,{kind:"seat",rigId:"r",logicalId:"l"});expect(seat.location).toEqual({scope:{kind:"seat",rigId:"r",logicalId:"l"},sourceHost:"local",view:"overview",spatialMode:"scene",spatialQuery:""});
  expect(seat.issues.map(i=>i.field)).toEqual(["view"]);
});
it.each(["sourceHost=local&sourceHost=local","sourceHost=%GG","sourceHost=%ED%A0%80","sourceHost="])("invalid source blocks target through repeated adapter canonicalization: %s",search=>{
  for(let count=0;count<3;count++){
    const raw=parseTopologySearch("?"+search);const result=parseTopologyLocation(host,raw);expect(result.targetValid).toBe(false);expect(result.sourceState).toBe("invalid");
    search=stringifyTopologySearch(raw).slice(1);
  }
});
it.each(["selectedRig=r","selectedNode=n","selectedRig=r&selectedRig=r&selectedNode=n","selectedRig=foreign&selectedNode=n","selectedRig=r&selectedNode=%GG"])("invalid selection clears only selection and preserves usable rig topology: %s",search=>{
  const result=parse("?sourceHost=local&view=spatial&"+search,{kind:"rig",rigId:"r"});expect(result.targetValid).toBe(true);expect(result.location.selection).toBeUndefined();expect(result.issues).toContainEqual(expect.objectContaining({field:"selection",blocking:false}));
});
it("bad/duplicate optional enums and query show notices without blocking source",()=>{
  const result=parse("?sourceHost=local&view=invalid&spatialMode=bad&spatialQuery=a&spatialQuery=b");expect(result.targetValid).toBe(true);
  expect(result.location).toMatchObject({view:"graph",spatialMode:"scene",spatialQuery:""});expect(result.issues.map(i=>i.field)).toEqual(["view","spatialMode","spatialQuery"]);
});
it("query limits use code points, identity limits use UTF16 units; neither is trimmed/truncated",()=>{
  const query="🙂".repeat(256),identity="🙂".repeat(1024);expect(buildTopologyLink({scope:host,sourceHost:"local",spatialQuery:query}).ok).toBe(true);
  expect(parseTopologyLocation(host,{sourceHost:identity}).sourceState).toBe("asserted");expect(parseTopologyLocation(host,{sourceHost:identity+"x"}).issues[0]?.code).toBe("too_large");
  expect(parseTopologyLocation(host,{sourceHost:"local",spatialQuery:query+"x"}).location.spatialQuery).toBe("");
  expect(buildTopologyLink({scope:host,sourceHost:"local",spatialQuery:query+"x"})).toMatchObject({ok:false});
});
it.each(["\ud800","\udfff"])("unpaired surrogate identities fail without an unsafe href (%#)",value=>{
  expect(buildTopologyLink({scope:host,sourceHost:value})).toMatchObject({ok:false});expect(()=>stringifyTopologySearch({sourceHost:value})).toThrow();
  expect(parseTopologyLocation(host,{sourceHost:"local",spatialQuery:value})).toMatchObject({targetValid:true,issues:[{field:"spatialQuery",code:"invalid",blocking:false}]});
});
it("whole serialized path/query budget includes unrelated metadata; hash is excluded",()=>{
  expect(parseTopologyLocation(host,{sourceHost:"local"},{serializedPathAndQuery:"/topology?other="+"x".repeat(16384)}).targetValid).toBe(false);
  expect(parseTopologyLocation(host,{sourceHost:"local"},{serializedPathAndQuery:"/topology?sourceHost=local#"+"x".repeat(20000)}).targetValid).toBe(true);
  const result=buildTopologyLink({scope:{kind:"seat",rigId:"🙂".repeat(1024),logicalId:"🙂".repeat(1024)},sourceHost:"local"});expect(result).toMatchObject({ok:false,issues:[{field:"location",code:"too_large",blocking:true}]});expect(result).not.toHaveProperty("target");
});
it.each([".","..","line\nbreak"])("unrepresentable path segment %s fails instead of remapping target",value=>{
  expect(buildTopologyLink({scope:{kind:"seat",rigId:"r",logicalId:value},sourceHost:"local"})).toMatchObject({ok:false});
});
it("new links copy only allowlisted fields; seat default omits irrelevant spatial state",()=>{
  const result=buildTopologyLink({scope:{kind:"seat",rigId:"r",logicalId:"logical/id"},sourceHost:"local",spatialQuery:"discard",selection:{rigId:"r",nodeId:"graph-id"},credential:"must not copy",hash:"private"} as any);
  expect(result).toMatchObject({ok:true,target:{href:"/topology/seat/r/logical%2Fid?sourceHost=local",params:{rigId:"r",logicalId:"logical/id"},search:{sourceHost:"local"}}});
});
it("graph selection needs exact source/rig/node and served pod namespace; logical/display IDs are never substitutes",()=>{
  const scope:TopologyScope={kind:"pod",rigId:"r",podName:"pod/exact"},selected={rigId:"r",nodeId:"graph-id"};
  const candidate={hostId:"A",rigId:"r",nodeId:"graph-id",podNamespace:"pod/exact"};expect(topologySelectionMatches(scope,"A",selected,candidate)).toBe(true);
  for(const changed of [{hostId:"B"},{rigId:"other"},{nodeId:"logical-id"},{podNamespace:"pod"}])expect(topologySelectionMatches(scope,"A",selected,{...candidate,...changed})).toBe(false);
});
it("legacy source is not inferred local, malformed route identity blocks",()=>{
  expect(parse("?view=spatial")).toMatchObject({sourceState:"legacy",location:{view:"spatial"}});expect(parse("?view=spatial").location.sourceHost).toBeUndefined();
  expect(parseTopologyLocation({kind:"rig",rigId:""},{sourceHost:"local"}).targetValid).toBe(false);
  expect(parseTopologyLocation(host,{sourceHost:"local"},{serializedPathAndQuery:"/topology/rig/a%0Ab?sourceHost=local"}).targetValid).toBe(false);
});
