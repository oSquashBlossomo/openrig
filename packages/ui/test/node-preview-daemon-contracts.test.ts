// @vitest-environment node
// In-memory Hono + injected inert capture; no listener or native session.
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { nodesRoutes, sessionAdminRoutes } from "../../daemon/src/routes/sessions.js";
import { fetchNodePreview, fetchSessionPreview } from "../src/hooks/useNodePreview.js";
afterEach(()=>vi.unstubAllGlobals());
function fixture(available=true) {
  const calls:Array<{sessionName:string;lines:number}>=[];const app=new Hono();
  app.use("*",async(c,next)=>{
    c.set("terminalBearerToken" as never,null as never);
    c.set("rigRepo" as never,{getRig:(id:string)=>id==="private-rig"?{nodes:[
      {id:"opaque-node",logicalId:"driver",binding:{tmuxSession:"native-bound:session"}},
      {id:"unbound-node",logicalId:"unbound",binding:null},
    ]}:null} as never);
    if(available)c.set("sessionTransport" as never,{capture:async(sessionName:string,opts:{lines:number})=>{
      calls.push({sessionName,lines:opts.lines});return sessionName==="missing"?{ok:false,reason:"session_missing",error:"private capture absent"}
        :{ok:true,content:"",lines:0,sessionName};
    }} as never);
    await next();
  });
  app.route("/api/rigs/:rigId/nodes",nodesRoutes);app.route("/api/sessions",sessionAdminRoutes);
  vi.stubGlobal("fetch",vi.fn((url:string,opts?:RequestInit)=>app.request(url,opts)));
  return {calls};
}
it("real node route owns native binding resolution; logical and opaque node IDs do not fabricate session names",async()=>{
  const {calls}=fixture();const logical=await fetchNodePreview("private-rig","driver",99999),opaque=await fetchNodePreview("private-rig","opaque-node",50);
  expect(logical).toMatchObject({content:"",lines:0,sessionName:"native-bound:session",capturedAt:expect.any(String)});
  expect(opaque).toMatchObject({sessionName:"native-bound:session"});expect(calls).toEqual([{sessionName:"native-bound:session",lines:1000},{sessionName:"native-bound:session",lines:50}]);
});
it("real session route echoes exact requested identity and server line default, without another native lookup",async()=>{
  const {calls}=fixture();expect(await fetchSessionPreview("native-bound:session",NaN)).toMatchObject({sessionName:"native-bound:session",lines:0});
  expect(calls).toEqual([{sessionName:"native-bound:session",lines:50}]);
});
it("real404/409/502 preserve unbound/absent native evidence as unavailable",async()=>{
  const {calls}=fixture();expect(await fetchNodePreview("absent","driver",50)).toMatchObject({unavailable:true,reason:'Rig "absent" not found.'});
  expect(await fetchNodePreview("private-rig","unbound",50)).toMatchObject({unavailable:true,reason:"session_unbound"});
  expect(await fetchSessionPreview("missing",50)).toEqual({unavailable:true,reason:"session_missing",hint:"private capture absent"});
  expect(calls).toEqual([{sessionName:"missing",lines:50}]);
});
it("real503 retains unavailable transport facts for both addressing contracts",async()=>{
  const {calls}=fixture(false);expect(await fetchNodePreview("private-rig","driver",50)).toMatchObject({unavailable:true,reason:"preview_unavailable"});
  expect(await fetchSessionPreview("native-bound:session",50)).toMatchObject({unavailable:true,reason:"preview_unavailable"});expect(calls).toEqual([]);
});
