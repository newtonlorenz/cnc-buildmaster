import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {gridAxis,previewGrid,gridChoices} from '../scripts/cnc-map-ui/src/mapping-plan.js';

test('live grid counts agree with authoritative Python planning, including boundary intervals',()=>{
  const cases=[[0,180,50],[-123.45,-3.45,30],[0,1,.3],[0,1,.333],[0,10,3.333],[0,10,.1],[0,9.9,.1],[0,100,100],[0,1,.0001],[0,1,2],[0,1,.1234],[-.3,.3,.1]];
  const python=execFileSync('python3',['-c',`import json,sys
sys.path.insert(0,'scripts')
from cnc_map_terminal import grid_axis
out=[]
for args in json.loads(sys.argv[1]):
 try: out.append(grid_axis(*args))
 except ValueError: out.append(None)
print(json.dumps(out))`,JSON.stringify(cases)],{encoding:'utf8'});
  cases.forEach((args,i)=>{
    const expected=JSON.parse(python)[i];
    if(expected===null)assert.throws(()=>gridAxis(...args));
    else assert.deepEqual(gridAxis(...args),expected);
  });
});
test('preview includes return, detects start membership and enforces map size',()=>{
  const area={x:[0,180],y:[0,120]};
  assert.equal(previewGrid(area,60,{x:0,y:0}).placements,13);
  assert.equal(previewGrid(area,60,{x:5,y:0}).startsHere,false);
  assert.equal(previewGrid(area,60,{x:180,y:120}).startsHere,true);
  assert.match(previewGrid({x:[0,70],y:[0,70]},1).error,/2,500/);
  assert.equal(previewGrid(null,10),null);
});
test('spacing presets disclose increasing work without implying accuracy',()=>{
  for(const area of [{x:[0,180],y:[0,120]},{x:[-10.123,31.876],y:[-30,30]},{x:[0,.2],y:[0,.3]}]){
    const choices=gridChoices(area);
    for(const c of choices){if(!c.draft.error)assert.deepEqual(c.draft,previewGrid(area,c.spacing));}
    assert.ok(choices[0].draft.placements<=choices[2].draft.placements);
  }
});
