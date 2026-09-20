import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {build} from '../scripts/cnc-map-ui/node_modules/esbuild/lib/main.js';

const bundle=await build({entryPoints:['scripts/cnc-map-ui/src/lib/surface-results.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {summariseSurface,createSurfaceReport,surfaceReportFilename,surfaceImportBlocker,verifiedSurfaceReceipt}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const route=[{x:10,y:20},{x:30,y:20},{x:30,y:40},{x:10,y:40},{x:10,y:20}];
const fixture=()=>({
  sessionId:'measurement-session',apiVersion:7,phase:'complete',demo:false,offline:false,busy:false,continuityActive:true,preparationClosed:false,
  scanStarted:1789876800,probeMode:'puck',planId:'approved-plan',area:{x:[10,30],y:[20,40]},
  plan:{grid:{x:[10,30],y:[20,40],spacing:20},probe:{repeatTolerance:.025,driftTolerance:.08},expectedG54:{x:1,y:2,z:3},puckHeight:14},
  route:{points:structuredClone(route)},
  measurements:route.map((point,i)=>({...point,contactZ:[100,100.02,99.97,100.01,100.07][i],spread:[.002,.003,.001,.002,.008][i],first:{z:100.002},second:{z:100},utc:`2026-09-20T10:00:0${i}.000Z`})),
  result:{path:'/evidence/surface.xyz',summary:{drift:.07,requiredG54Z:86}},
});
const access={online:true,pending:false,activeHold:null,isActive:true};
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('grid range uses actual second contacts relative to sample 1 and excludes the return',()=>{
  const state=fixture(),original=structuredClone(state),summary=summariseSurface(state);
  near(summary.reference,100);near(summary.minRelativeZ,-.03);near(summary.maxRelativeZ,.02);near(summary.heightRange,.05);
  near(summary.returnDrift,.07);near(summary.maxRepeatSpread,.008);
  assert.equal(summary.grid.length,4);assert.equal(summary.returnPoint.number,5);assert.equal(summary.complete,true);
  assert.deepEqual(summary.samples.map(p=>p.kind),['grid','grid','grid','grid','return']);
  assert.deepEqual(state,original,'Summarising must not mutate the authoritative snapshot');
});
test('partial, stopped and awaiting-acceptance runs cannot claim completion',()=>{
  const state=fixture();state.phase='stopped';state.measurements=state.measurements.slice(0,2);
  let summary=summariseSurface(state);assert.equal(summary.complete,false);assert.equal(summary.returnPoint,null);assert.equal(summary.returnDrift,null);assert.equal(summary.grid.length,2);near(summary.heightRange,.02);
  state.measurements=fixture().measurements;summary=summariseSurface(state);assert.equal(summary.fullMeasurements,true);assert.equal(summary.complete,false);
  state.phase='scan';assert.equal(summariseSurface(state).complete,false);
  state.phase='complete';state.measurements.pop();assert.equal(summariseSurface(state).complete,false);
});
test('flat data preserves exact zero; no-data is unavailable, not zero',()=>{
  const state=fixture();state.measurements.forEach(p=>{p.contactZ=100;p.spread=0;});
  const summary=summariseSurface(state);assert.equal(summary.heightRange,0);assert.equal(summary.returnDrift,0);assert.equal(summary.maxRepeatSpread,0);assert.equal(summary.complete,true);
  state.measurements=[];const empty=summariseSurface(state);assert.equal(empty.heightRange,null);assert.equal(empty.maxRepeatSpread,null);assert.equal(empty.returnDrift,null);assert.equal(empty.reference,null);
});
test('missing and non-finite numbers never fabricate a reference or successful full scan',()=>{
  for(const bad of [null,undefined,NaN,Infinity,'100']){
    const state=fixture();state.measurements[0].contactZ=bad;
    const summary=summariseSurface(state);assert.equal(summary.reference,null);assert.equal(summary.heightRange,null);assert.equal(summary.returnDrift,null);assert.equal(summary.complete,false);assert.ok(summary.issues.length);
  }
  const state=fixture();state.measurements[2].spread=-.1;assert.equal(summariseSurface(state).complete,false);
});
test('duplicate, out-of-order, extra and misplaced return records cannot masquerade as complete',()=>{
  const duplicate=fixture();duplicate.measurements[1]={...duplicate.measurements[0]};assert.equal(summariseSurface(duplicate).complete,false);assert.equal(summariseSurface(duplicate).grid.length,3);
  const swapped=fixture();[swapped.measurements[1],swapped.measurements[2]]=[swapped.measurements[2],swapped.measurements[1]];assert.equal(summariseSurface(swapped).complete,false);
  const misplaced=fixture();misplaced.measurements.at(-1).x=30;assert.equal(summariseSurface(misplaced).returnPoint,null);assert.equal(summariseSurface(misplaced).complete,false);
  const extra=fixture();extra.measurements.push({...extra.measurements[0]});assert.equal(summariseSurface(extra).complete,false);
});
test('unknown grids leave roles and height range unconfirmed while preserving records',()=>{
  const state=fixture();delete state.plan;
  const summary=summariseSurface(state);assert.equal(summary.expectedGrid,null);assert.equal(summary.heightRange,null);assert.equal(summary.complete,false);assert.ok(summary.samples.every(p=>p.kind==='unclassified'));
  assert.deepEqual(createSurfaceReport(state).measurements,state.measurements);
});
test('report retains provenance and original contacts, labels simulation, and is never a cutting map',()=>{
  const privateMarker=randomUUID();
  const state=fixture();state.measurements[2].simulated=true;state.authToken=privateMarker;state.status={secret:privateMarker};
  const report=createSurfaceReport(state,new Date('2026-09-20T10:30:45.123Z'));
  assert.equal(report.simulated,true);assert.equal(report.importableAsMap,false);assert.equal(report.cuttingReleased,false);
  assert.equal(report.provenance.sessionId,state.sessionId);assert.equal(report.provenance.planId,state.planId);assert.equal(report.provenance.scanStarted,state.scanStarted);
  assert.deepEqual(report.plan,state.plan);assert.deepEqual(report.area,state.area);assert.equal(report.probeMode,'puck');assert.deepEqual(report.measurements,state.measurements);
  assert.match(report.purpose,/Cannot import.*No cutting release/);assert.ok(!JSON.stringify(report).includes(privateMarker));
  assert.equal(surfaceReportFilename(report),'surface-measurements-simulated-2026-09-20T10-30-45-123Z.json');
});
test('native import remains gated by active view, real mode, connection, operation and server acceptance',()=>{
  assert.equal(surfaceImportBlocker(fixture(),access),null);
  for(const patch of [{demo:true},{offline:true},{busy:true},{phase:'scan'},{result:null},{preparationClosed:true},{continuityActive:false},{continuityActive:undefined}])assert.ok(surfaceImportBlocker({...fixture(),...patch},access));
  for(const patch of [{online:false},{isActive:false},{pending:true},{activeHold:{id:'held'}}])assert.ok(surfaceImportBlocker(fixture(),{...access,...patch}));
  const mixed=fixture();mixed.measurements[0].simulated=true;assert.match(surfaceImportBlocker(mixed,access),/Simulated/);
});
test('import receipts require server readback and checksum, never a local confirmation',()=>{
  const state=fixture();assert.equal(verifiedSurfaceReceipt(state),null);
  state.handoff={verified:true};assert.equal(verifiedSurfaceReceipt(state),null);
  state.handoff={verified:true,sha256:'a'.repeat(64),compensationApplied:false,continuityVerified:false,materialZVerified:false};assert.deepEqual(verifiedSurfaceReceipt(state),state.handoff);
  state.phase='stopped';assert.equal(verifiedSurfaceReceipt(state),null);
  state.phase='complete';state.demo=true;assert.equal(verifiedSurfaceReceipt(state),null);
});
