import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
const artifacts='output/design-review/levelling';await mkdir(artifacts,{recursive:true});
const server=spawn('python3',['scripts/cnc_map_web.py','--demo','--port','0'],{stdio:['ignore','pipe','pipe']});
let browser;
try{
  const url=await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{const m=String(d).match(/Open (http:\S+)/);if(m)resolve(m[1]);});server.once('exit',()=>reject(Error('Demo exited')));});
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960},colorScheme:'light'});
  const writes=[],errors=[];page.on('request',r=>{if(r.method()==='POST')writes.push({url:r.url(),data:r.postDataJSON()});});page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(url);await page.waitForFunction(()=>state?.demo&&state.apiVersion===6);
  await page.locator('#attest').check();await page.locator('#arm').click();await page.waitForFunction(()=>state.armed&&!sending);
  assert.equal(await page.locator('#completeRectangle').isVisible(),false);
  await page.locator('.manual-entry summary').click();
  for(const [corner,x,y] of [['front-left','0','0'],['back-right','60','40']]){
    await page.locator('#corner').selectOption(corner);await page.locator('#cornerX').fill(x);await page.locator('#cornerY').fill(y);await page.locator('#saveCorner').click();
    await page.waitForFunction(n=>state.corners.some(p=>p.name===n)&&!sending,corner);
  }
  await page.locator('#completeRectangle').waitFor({state:'visible'});
  const pos=await page.evaluate(()=>state.status.machineCoord),before=writes.length;
  await page.locator('#completeRectangle').click();await page.locator('#gridPanel').waitFor({state:'visible'});
  assert.deepEqual(await page.evaluate(()=>state.status.machineCoord),pos);
  assert.equal(await page.evaluate(()=>state.corners.filter(p=>p.source==='inferred').length),2);
  assert.deepEqual(writes.slice(before).map(w=>w.url.split('/').at(-1)),['complete-rectangle']);
  assert.equal(await page.locator('#spacing').inputValue(),'20'); // Valid preset for small stock.
  assert.match(await page.locator('#gridDraft').textContent(),/13 puck placements/);
  assert.equal(await page.locator('[data-draft-point]').count(),12);
  const planningWrites=writes.length;
  await page.locator('[data-grid-choice="1"]').click();assert.match(await page.locator('#gridDraft').textContent(),/36 puck placements/);
  await page.locator('[data-grid-choice="0"]').click();
  await page.locator('h1').click();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
  assert.equal(writes.length,planningWrites,'Grid navigation or keys issued a machine action');
  await page.locator('#preview').click();await page.waitForFunction(()=>state.plan&&!sending);
  assert.match(await page.locator('#planText').textContent(),/probe 10 then 5 mm\/min/);
  assert.match(await page.locator('#planText').textContent(),/168.0 s/);
  await page.locator('#spacing').fill('13.333');
  assert.match(await page.locator('#gridDraft').textContent(),/under 0.1/);
  assert.equal(await page.locator('#preview').isDisabled(),true);
  assert.equal(await page.locator('#scan').isDisabled(),true);
  assert.equal(await page.locator('[data-route="scan"]').count(),0,'Old approved route shown for invalid draft');
  await page.locator('[data-grid-choice="0"]').click();
  assert.equal(await page.locator('#scan').isDisabled(),false);
  await page.screenshot({path:artifacts+'/grid-desktop.png',fullPage:true});
  // Explicit positioning remains available when the current point is off-grid.
  await page.locator('#backToArea').click();await page.locator('#clickMove').check();
  const centre=await page.locator('#plot').evaluate(svg=>{const p=svg.createSVGPoint();p.x=320;p.y=205;const q=p.matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y};});
  await page.mouse.click(centre.x,centre.y);await page.waitForFunction(()=>!state.busy&&!sending&&state.status.machineCoord.x>29);
  await page.locator('#toPlanning').click();assert.equal(await page.locator('#preview').isDisabled(),true);
  await page.locator('#gridReturn').waitFor({state:'visible'});
  await page.locator('#gridReturn').click();await page.waitForFunction(()=>!state.busy&&!sending);
  assert.equal(await page.locator('#preview').isDisabled(),false);
  await page.locator('#preview').click();await page.waitForFunction(()=>state.plan&&!sending);
  await page.locator('#scan').click();await page.waitForFunction(()=>state.prompt?.expected==='confirm startup'&&!sending);
  assert.equal(await page.locator('#promptText').isVisible(),true);
  await page.locator('#ready').click();await page.waitForFunction(()=>state.prompt?.expected==='contact ready'&&!sending);
  await page.locator('#ready').click();await page.waitForFunction(()=>state.prompt?.expected===''&&!sending);
  assert.match(await page.locator('#measureTitle').textContent(),/point 1 of 13/);
  assert.match(await page.locator('#scanRemaining').textContent(),/including setup and waiting/);
  assert.equal(await page.locator('#promptText').isVisible(),false);
  await page.locator('#probeDetails summary').click();assert.match(await page.locator('#probeContract').textContent(),/gap below 5 mm/);
  await page.locator('#probeDetails summary').click();
  await page.screenshot({path:artifacts+'/placement-desktop.png',fullPage:true});
  await page.locator('#appearance').selectOption('dark');await page.screenshot({path:artifacts+'/placement-dark.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.ok((await page.locator('#ready').boundingBox()).y<844,'Readiness hidden below map on mobile');
  await page.screenshot({path:artifacts+'/placement-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:960});
  // Every point keeps a separate readiness token; return check cannot disappear.
  const ids=new Set();
  for(let i=1;i<=13;i++){
    const prompt=await page.evaluate(()=>state.prompt);assert.ok(!ids.has(prompt.id));ids.add(prompt.id);
    if(i===13){assert.match(await page.locator('#measureTitle').textContent(),/Repeat the starting point/);assert.match(await page.locator('#ready').textContent(),/check return/);}
    await page.locator('#ready').click();await page.waitForFunction(id=>state.prompt?.id!==id&&!sending,prompt.id);
  }
  assert.equal(await page.evaluate(()=>state.prompt.expected),'accept observations');
  assert.equal(await page.locator('#pointGuide').isVisible(),false);
  await page.locator('#ready').click();await page.waitForFunction(()=>state.phase==='complete');
  assert.equal(await page.locator('#ugsHandoff').isVisible(),false,'Demo offered usable map');
  assert.equal(await page.evaluate(()=>state.measurements.length),13);
  // Four inconsistent corners must stay in teaching with the correction visible.
  await page.locator('#newMap').click();await page.waitForFunction(()=>state.phase==='setup'&&!sending);
  await page.locator('#attest').check();await page.locator('#arm').click();await page.waitForFunction(()=>state.armed&&!sending);
  if(!await page.locator('.manual-entry').evaluate(e=>e.open))await page.locator('.manual-entry summary').click();
  for(const [corner,x,y] of [['front-left','0','0'],['front-right','60','0'],['back-right','60','40'],['back-left','1','40']]){
    await page.locator('#corner').selectOption(corner);await page.locator('#cornerX').fill(x);await page.locator('#cornerY').fill(y);await page.locator('#saveCorner').click();
    await page.waitForFunction(n=>state.corners.some(p=>p.name===n)&&!sending,corner);
  }
  assert.equal(await page.locator('#geometryIssue').isVisible(),true);
  assert.equal(await page.locator('#step2').isDisabled(),true);
  assert.equal(await page.locator('#toPlanning').isDisabled(),true);
  await page.evaluate(()=>showMappingView('grid'));
  assert.equal(await page.locator('#teach').isVisible(),true);
  assert.equal(await page.locator('#gridPanel').isVisible(),false);
  await page.locator('#cornerX').fill('0');await page.locator('#saveCorner').click();await page.waitForFunction(()=>state.area&&!sending);
  await page.locator('#toPlanning').click();assert.equal(await page.locator('#gridPanel').isVisible(),true);
  await page.locator('#stop').click();await page.waitForFunction(()=>state.phase==='stopped');
  assert.deepEqual(errors,[]);
  console.log('Efficient mapping passed: atomic two-corner completion without motion, live grid counts, strict draft validation, stage/input isolation, explicit return to grid, per-point readiness, reference return, desktop/dark/mobile placement view. Demo only.');
}finally{if(browser)await browser.close();if(server.exitCode===null){const stopped=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await stopped;}}
