// @vitest-environment node
// Actual Hono/private SQLite/files only; no listener, native provider or installed fleet.
import {afterEach,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDb} from '../../daemon/src/db/connection.js';
import {migrate} from '../../daemon/src/db/migrate.js';
import {ALL_MIGRATIONS} from '../../daemon/src/db/all-migrations.js';
import {SliceIndexer} from '../../daemon/src/domain/slices/slice-indexer.js';
import {SliceDetailProjector} from '../../daemon/src/domain/slices/slice-detail-projector.js';
import {WorkflowSpecCache,parseWorkflowSpec} from '../../daemon/src/domain/workflow-spec-cache.js';
import {QueueRepository} from '../../daemon/src/domain/queue-repository.js';
import {EventBus} from '../../daemon/src/domain/event-bus.js';
import {slicesRoutes} from '../../daemon/src/routes/slices.js';
import {missionsRoutes} from '../../daemon/src/routes/missions.js';
import {queueRoutes} from '../../daemon/src/routes/queue.js';
import {readSlicesList,readSliceDetail,readSliceDoc,readQueueMapItem} from '../src/hooks/useSlices.js';
import {readMission} from '../src/hooks/useMission.js';
const cleanups:Array<()=>void>=[];
afterEach(()=>{vi.unstubAllGlobals();cleanups.splice(0).forEach(fn=>fn());});
function fixture(){const db=createDb();migrate(db,ALL_MIGRATIONS);const root=mkdtempSync(join(tmpdir(),'gui-slice-mission-contract-'));cleanups.push(()=>{db.close();rmSync(root,{recursive:true,force:true})});const missions=join(root,'missions');mkdirSync(missions);
 const indexer=new SliceIndexer({db,slicesRoot:missions,dogfoodEvidenceRoot:null,additionalSliceRoots:[]});const projector=new SliceDetailProjector({db,indexer});const cache=new WorkflowSpecCache(db);const repo=new QueueRepository(db,new EventBus(db),{loadHumanRegistry:()=>({ok:true,entities:[]})});const app=new Hono();app.use('*',async(c,next)=>{c.set('sliceIndexer' as never,indexer as never);c.set('sliceDetailProjector' as never,projector as never);c.set('workflowSpecCache' as never,cache as never);c.set('queueRepo' as never,repo as never);await next()});app.route('/api/slices',slicesRoutes());app.route('/api/missions',missionsRoutes());app.route('/api/queue',queueRoutes());vi.stubGlobal('fetch',vi.fn((url:string,opts?:RequestInit)=>app.request(url,opts)));
 function slice(name:string,qitem?:string){const dir=join(missions,'mission','slices',name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'README.md'),`---\nstatus: active\n${qitem?`qitems: [${qitem}]\n`:''}---\n# ${name}`);indexer.invalidate();return dir}
 function binding(name:string,version:string,sliceName:string,id:string){const yaml=`workflow:\n  id: ${JSON.stringify(name)}\n  version: ${JSON.stringify(version)}\n  entry: {role: worker}\n  roles: {worker: {preferred_targets: [worker@fixture]}}\n  steps: [{id: work, actor_role: worker, allowed_exits: [done]}]\n`;const parsed=parseWorkflowSpec(yaml,'fixture.yaml');expect(parsed.id).toBe(name);expect(parsed.version).toBe(version);const path=join(root,`${id}.yaml`);writeFileSync(path,yaml);const cached=cache.readThrough(path);expect(cached.name).toBe(name);expect(cached.version).toBe(version);
 db.prepare("INSERT INTO queue_items (qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body) VALUES (?, '2026-05-04T00:00:00Z', '2026-05-04T00:00:00Z','a@r','b@r','in-progress','routine',?)").run(id,`work for ${sliceName}`);slice(sliceName,id);db.prepare("INSERT INTO workflow_instances (instance_id,workflow_name,workflow_version,created_by_session,created_at,status,current_frontier_json,hop_count) VALUES (?, ?, ?, 'creator@r','2026-05-04T00:00:00Z','active',?,0)").run(`instance-${id}`,name,version,JSON.stringify([id]));}
 return {db,root,app,indexer,slice,binding};}
it('reads exact legacy workspace slice/mission, authored reserved doc path and additive/null facts',async()=>{const {slice}=fixture();const dir=slice('one');mkdirSync(join(dir,'docs'));const relPath='docs/why?exact#v1%.md';writeFileSync(join(dir,relPath),'');const detail=await readSliceDetail('one','local');expect(detail).toMatchObject({name:'one',missionId:'mission',slicePath:dir,workflowBinding:null});expect(await readSliceDoc('one',relPath,'local')).toEqual({relPath,content:''});const m=await readMission('mission','local');expect(m).toMatchObject({missionId:'mission',workflow_spec:null,topology:null});expect(await readSlicesList('all',null,'local')).toMatchObject({filter:'all',totalCount:1,boundToWorkflow:null});});
it('retains actual404 queue null/mission unavailable and slice/doc HTTP errors',async()=>{fixture();expect(await readQueueMapItem('missing')).toBeNull();expect(await readMission('missing','local')).toEqual({unavailable:true,error:'mission_not_found'});await expect(readSliceDetail('missing','local')).rejects.toThrow('HTTP 404');await expect(readSliceDoc('missing','README.md','local')).rejects.toThrow('HTTP 404');});
it('proves valid parsed colon pairs collide in legacy route but explicit pair selects the exact workflow',async()=>{const {app,binding}=fixture();binding('flow:part','v1','first','q-first');binding('flow','part:v1','second','q-second');const legacy=await app.request('/api/slices?boundToWorkflow=flow%3Apart%3Av1');expect((await legacy.json()).slices.map((s:any)=>s.name)).toEqual(['first']);const result=await readSlicesList('all',{specName:'flow',specVersion:'part:v1'},'local');expect(result).toMatchObject({boundToWorkflow:{specName:'flow',specVersion:'part:v1',matched:1}});expect('slices' in result&&result.slices.map(s=>s.name)).toEqual(['second']);});
it.each(['boundToWorkflowName=flow','boundToWorkflowVersion=v1','boundToWorkflowName=&boundToWorkflowVersion=v1','boundToWorkflowName=flow&boundToWorkflowVersion='])('rejects incomplete/empty explicit workflow pair %s',async params=>{const {app}=fixture();const res=await app.request(`/api/slices?${params}`);expect(res.status).toBe(400);expect(await res.json()).toMatchObject({error:'boundToWorkflow_invalid'});});
it('explicit and legacy filters may coexist only when they select the same pair',async()=>{const {app,binding}=fixture();binding('flow:part','v1','first','q-first');const okay=await app.request('/api/slices?boundToWorkflow=flow%3Apart%3Av1&boundToWorkflowName=flow%3Apart&boundToWorkflowVersion=v1');expect(okay.status).toBe(200);const wrong=await app.request('/api/slices?boundToWorkflow=other%3Av1&boundToWorkflowName=flow%3Apart&boundToWorkflowVersion=v1');expect(wrong.status).toBe(400);expect(await wrong.json()).toMatchObject({error:'boundToWorkflow_invalid'});});

it('representable filters work through the actual legacy route; old origins cannot silently accept colon versions',async()=>{const {app,binding}=fixture();binding('flow:part','v1','first','q-first');binding('flow','part:v1','second','q-second');
 // Model an older origin by exposing only the route's unchanged legacy parser.
 const fetch=vi.fn((url:string,opts?:RequestInit)=>{const u=new URL(url,'http://fixture.local');u.searchParams.delete('boundToWorkflowName');u.searchParams.delete('boundToWorkflowVersion');return app.request(u.pathname+'?'+u.searchParams,opts)});vi.stubGlobal('fetch',fetch);
 const ordinary=await readSlicesList('all',{specName:'flow:part',specVersion:'v1'},'remote/exact');expect('slices' in ordinary&&ordinary.slices.map(s=>s.name)).toEqual(['first']);expect(fetch.mock.calls[0][0]).toContain('boundToWorkflow=flow%3Apart%3Av1');
 await expect(readSlicesList('all',{specName:'flow',specVersion:'part:v1'},'remote/exact')).rejects.toMatchObject({code:'invalid_contract'});expect(fetch.mock.calls[1][0]).not.toContain('boundToWorkflow=');
});
