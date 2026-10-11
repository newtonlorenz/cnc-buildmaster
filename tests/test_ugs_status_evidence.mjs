import test from 'node:test';
import assert from 'node:assert/strict';
import {machineStatusEvidence} from '../scripts/cnc-map-ui/src/machine-status.js';

const reported = (status, extra={}) => ({phase:'teach', controllerReport:{status,fresh:true,ageMs:100}, ...extra});
test('non-default feed override is visible and missing override stays unknown',()=>{
 const result=machineStatusEvidence(reported({state:'RUN',overrides:{feed:200}}),true);
 assert.equal(result.feed,'Feed override 200%');assert.equal(result.nonDefaultFeed,true);
 for(const feed of [undefined,null,0,NaN,'100']) {
  const result=machineStatusEvidence(reported({state:'IDLE',overrides:{feed}}),true);
  assert.equal(result.feed,'Feed override unknown');
 }
});
test('HOLD is reported separately from physical stop and spindle stop',()=>{
 const result=machineStatusEvidence(reported({state:'HOLD',spindleSpeed:1000,overrides:{feed:100}}),true);
 assert.match(result.notice,/spindle may still run/);
 assert.match(result.notice,/acknowledged pause request is not a verified stop/);
 assert.equal(result.controller,'UGS report: HOLD');
});
test('ending a session never upgrades a prior report into a physical stop',()=>{
 const result=machineStatusEvidence(reported({state:'IDLE'},{phase:'stopped'}),true);
 assert.match(result.notice,/physical stop unverified/);
 assert.equal(result.fresh,false);
 assert.equal(result.controller,'Last UGS report: IDLE');
});
test('stale, absent and disconnected reports never present cached overrides as live',()=>{
 for(const [fresh,ageMs,online] of [[false,10,true],[true,3001,true],[true,10,false]]) {
  const result=machineStatusEvidence({phase:'teach',controllerReport:{status:{state:'RUN',overrides:{feed:200}},fresh,ageMs}},online);
  assert.equal(result.feed,'Last feed override 200%');assert.equal(result.fresh,false);
  assert.match(result.notice,/inactive or stale/);
 }
 const absent=machineStatusEvidence({phase:'setup',status:{state:'IDLE'}},true);
 assert.equal(absent.controller,'Controller report unavailable');
 assert.equal(absent.feed,'Feed override unknown');
 assert.equal(machineStatusEvidence({offline:true},true),null);
 assert.equal(machineStatusEvidence({demo:true},true),null);
});
