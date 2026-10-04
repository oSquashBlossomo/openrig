import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Hono } from "hono";
import { rmSync } from "node:fs";
import { transferableAbortController } from "node:util";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { coreSchema } from "../../daemon/src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../../daemon/src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../../daemon/src/db/migrations/003_events.js";
import { streamItemsSchema } from "../../daemon/src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../../daemon/src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../../daemon/src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../../daemon/src/db/migrations/037_mission_control_actions.js";
import { queueItemSummarySchema } from "../../daemon/src/db/migrations/044_queue_item_summary.js";
import { SliceIndexer } from "../../daemon/src/domain/slices/slice-indexer.js";
import { ReviewGatherer } from "../../daemon/src/domain/review/gather.js";
import { reviewRoutes } from "../../daemon/src/routes/review.js";
import { makeFixtureWorkspace, writeFixtureSlice } from "../../daemon/test/review-fixtures.js";
import { useSliceReview, useMissionReview, useReviewAgents, useRigAgents } from "../src/hooks/useReview.js";
import { useFleet } from "../src/hooks/useFleet.js";
// Actual composer/routes/private on-disk fixture and in-memory SQLite. No
// listener, native agent, registered remote or installed home is contacted.
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("retains actual nullable composed identities, scoped rows and unavailable host counts through all five hooks",async()=>{
  const ws=makeFixtureWorkspace(),db=createDb(":memory:"),client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try {
    migrate(db,[coreSchema,bindingsSessionsSchema,eventsSchema,streamItemsSchema,queueItemsSchema,queueTransitionsSchema,missionControlActionsSchema,queueItemSummarySchema]);
    writeFixtureSlice(ws,"private-mission","private-slice",{id:"REQ.PRIVATE.1",intent:"Private exact intent.",prd:{miniReqs:["exact requirement"]}});
    const indexer=new SliceIndexer({slicesRoot:ws.root,additionalSliceRoots:[],dogfoodEvidenceRoot:null,db});
    const gatherer=new ReviewGatherer({db,indexer,gitRepoPath:null,now:()=>"2026-10-04T00:00:00.000Z"});
    const app=new Hono();app.use("*",async(c,next)=>{c.set("reviewGatherer" as never,gatherer as never);c.set("hostRegistryExists" as never,(()=>true) as never);
      c.set("hostRegistryLoader" as never,(()=>({ok:true,registry:{hosts:[{id:"private-ssh",transport:"ssh",target:"never-contact.invalid"}]}})) as never);await next();});app.route("/api/review",reviewRoutes());
    const fetch=vi.fn(async(url:string,options:RequestInit={})=>{const native=transferableAbortController(),abort=()=>native.abort();options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();
      try{return await app.request(url,{...options,signal:native.signal});}finally{options.signal?.removeEventListener("abort",abort);}});vi.stubGlobal("fetch",fetch);
    const wrapper=({children}:{children:React.ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const {result}=renderHook(()=>({slice:useSliceReview("private-slice"),mission:useMissionReview("private-mission"),agents:useReviewAgents("slice:private-slice"),rig:useRigAgents(),fleet:useFleet()}),{wrapper});
    await waitFor(()=>expect(Object.values(result.current).every(q=>q.isSuccess)).toBe(true));
    expect(result.current.slice.data).toMatchObject({slice:"private-slice",sliceId:"REQ.PRIVATE.1",intent:{text:"Private exact intent."},lineage:{candidateSha:null,mergeSha:null,mainTip:"unknown"}});
    expect(result.current.mission.data).toMatchObject({mission:"private-mission",missionId:null});expect(result.current.agents.data).toMatchObject({scope:"slice:private-slice",coordinationHealth:null});
    expect(result.current.rig.data).toMatchObject({scope:"rig",settled:[]});const failed=result.current.fleet.data?.hosts.find(h=>h.hostId==="private-ssh");
    expect(failed).toMatchObject({kind:"remote",status:{status:"unsupported-transport"}});expect(failed).not.toHaveProperty("needsYouCount");expect(failed).not.toHaveProperty("seatCount");
    expect(result.current.fleet.data?.rollup).toMatchObject({hostCount:2,unreachableCount:1});expect(fetch).toHaveBeenCalledTimes(5);expect(fetch.mock.calls.every(([url])=>!url.includes("host="))).toBe(true);
  }finally{cleanup();client.clear();db.close();rmSync(ws.root,{recursive:true,force:true});}
});
