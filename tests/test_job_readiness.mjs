import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from '../scripts/cnc-map-ui/node_modules/esbuild/lib/main.js';
const bundle=await build({entryPoints:['scripts/cnc-map-ui/src/lib/job-readiness.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {preparationChecks,setupSheet}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const job=()=>({name:'Control | board <script>',workflow:{material:'pcb',intent:'isolation',sourceCompensation:'unknown'},stock:{width:100,height:70,thickness:1},placement:{x:0,y:0,angle:0,mirror:false},guide:{steps:[{id:'alignment',complete:false}],measured:false,mapMatchesJob:false,fingerprint:'test-only-hash'},operations:[{name:'test.nc',tool:'V-bit',diameter:.2,fits:true,depthOk:true,warnings:['The initial approach is not shown'],sha256:'source-hash'}]});
test('readiness separates source compensation, captured alignment and measured evidence',()=>{
 const j=job();let checks=preparationChecks(j,{offline:true});
 assert.equal(checks.filter(c=>c.complete).length,3);
 assert.match(checks.find(c=>c.id==='alignment').detail,/Capture fresh references/);
 j.workflow.sourceCompensation='applied';assert.match(preparationChecks(j,{}).find(c=>c.id==='source').detail,/Do not apply another map/);
 j.guide.steps[0].complete=true;j.workflow.sourceCompensation='none';
 assert.equal(preparationChecks(j,{}).find(c=>c.id==='surface').complete,false);
 assert.equal(preparationChecks(j,{phase:'complete',result:{path:'some'}}).find(c=>c.id==='surface').complete,false);
});
test('blocking source/stock checks link to relevant review while empty tools are not complete',()=>{
 const j=job();j.operations[0].warnings.push('Unsupported source assumption');
 assert.equal(preparationChecks(j,{}).find(c=>c.id==='stock').complete,false);
 j.operations[0].fits=false;assert.equal(preparationChecks(j,{}).find(c=>c.id==='stock').section,'pcbSetupSection');
 j.operations=[];assert.equal(preparationChecks(j,{}).some(c=>c.complete),false);
});
test('setup sheet preserves scope and escaped user data without inventing cutting authority',()=>{
 const report=setupSheet(job(),{demo:true,handoff:{verified:true}},'2026-09-20T00:00:00Z');
 assert.match(report,/SIMULATION — no machine evidence/);assert.match(report,/not a cutting release/);
 assert.match(report,/verified at import time; current physical continuity is unverified/);
 assert.ok(report.includes('Control \\| board &lt;script&gt;'));
 assert.ok(report.indexOf('Use Finish preparation') < report.indexOf('In UGS, establish material-top Z'));
 assert.ok(report.includes('source-hash'));assert.ok(!report.includes('[x] Surface measurements'));
});
