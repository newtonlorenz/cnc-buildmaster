import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { observeTransport } from './workbench_browser_helpers.mjs';
const server = spawn('python3', ['scripts/cnc_map_web.py', '--demo', '--port', '0'], { stdio: ['ignore','pipe','pipe'] });
let browser;
try {
  const url = await new Promise((resolve,reject) => { server.stdout.on('data', data => { const match=String(data).match(/Open (http:\S+)/); if(match)resolve(match[1]); }); server.once('exit',()=>reject(Error('Demo exited'))); });
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[],writes=[];page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
  await observeTransport(page);await page.goto(url);await page.locator('#surfaceTab').click();
  await page.locator('#attest').check();await page.locator('#arm').click();
  await page.waitForFunction(()=>window.testTransport.state?.armed&&!window.testTransport.pending);
  await page.getByRole('button',{name:'Enter selected corner coordinates'}).click();
  for(const [corner,x,y] of [['front-left','0','0'],['back-right','60','40']]){
    await page.locator('#corner').selectOption(corner);await page.locator('#cornerX').fill(x);await page.locator('#cornerY').fill(y);await page.locator('#saveCorner').click();
    await page.waitForFunction(name=>window.testTransport.state.corners.some(p=>p.name===name)&&!window.testTransport.pending,corner);
  }
  const original=await page.evaluate(()=>window.testTransport.state.sessionId);
  await page.locator('#completeRectangle').click();await page.locator('#gridPanel').waitFor({state:'visible'});
  assert.equal(await page.locator('#clearanceUp').isDisabled(),true);
  await page.locator('#edgeInset').fill('5');await page.locator('#spacing').fill('10');
  await page.locator('#gridReturn').click();
  await page.waitForFunction(()=>window.testTransport.state.status.machineCoord.x===5&&window.testTransport.state.status.machineCoord.y===5&&!window.testTransport.state.busy&&!window.testTransport.pending);
  await page.locator('#preview').click();await page.waitForFunction(()=>!!window.testTransport.state.planId&&!window.testTransport.pending);
  let plan=await page.evaluate(()=>window.testTransport.state.plan);assert.deepEqual(plan.grid.x,[5,15,25,35,45,55]);assert.deepEqual(plan.grid.y,[5,15,25,35]);
  await page.locator('#clearanceConfirmed').check();await page.locator('#clearanceUp').click();
  await page.waitForFunction(()=>window.testTransport.state.status.machineCoord.z===1&&!window.testTransport.state.busy&&!window.testTransport.pending);
  assert.equal(await page.evaluate(()=>window.testTransport.state.planId),null);
  assert.equal(await page.evaluate(()=>window.testTransport.state.corners.every(p=>p.z===1)),true);
  await page.locator('#clearanceStep').selectOption('0.1');await page.locator('#clearanceDown').click();
  await page.waitForFunction(()=>window.testTransport.state.status.machineCoord.z===.9&&!window.testTransport.state.busy&&!window.testTransport.pending);
  await page.locator('#preview').click();await page.waitForFunction(()=>!!window.testTransport.state.planId&&!window.testTransport.pending);
  await mkdir('output/design-review/recovery',{recursive:true});
  await page.screenshot({path:'output/design-review/recovery/grid-clearance.png',fullPage:true});
  await page.locator('#scan').click();
  while(await page.evaluate(()=>window.testTransport.state.measurements.length===0)){
    await page.locator('#ready').click();await page.waitForTimeout(200);
  }
  await page.locator('#stop').click();await page.waitForFunction(()=>window.testTransport.state.phase==='stopped'&&!window.testTransport.pending);
  await page.locator('#historyToggle').click();await page.locator('#surfaceHistory').selectOption(original);await page.locator('#previewHistory').click();
  await page.getByText(/Historical view/).waitFor();
  const actions=writes.filter(url=>/\/(jog|goto|clearance-jog)$/.test(url)).length;
  await page.locator('#surfaceFit').click();
  assert.equal(writes.filter(url=>/\/(jog|goto|clearance-jog)$/.test(url)).length,actions);
  await page.screenshot({path:'output/design-review/recovery/history.png',fullPage:true});
  await page.locator('#fresh').click();await page.waitForFunction(id=>window.testTransport.state.sessionId!==id&&window.testTransport.state.phase==='setup'&&!window.testTransport.pending,original);await page.locator('#attest').check();await page.locator('#arm').click();
  await page.waitForFunction(()=>window.testTransport.state.armed&&!window.testTransport.pending);
  await page.locator('#confirmHistory').check();await page.locator('#restoreHistory').click();
  await page.waitForFunction(()=>window.testTransport.state.corners.length===4&&!window.testTransport.pending);
  assert.equal(await page.evaluate(()=>window.testTransport.state.measurements.length),0);
  assert.equal(await page.evaluate(()=>window.testTransport.state.planId),null);
  assert.equal(await page.evaluate(()=>window.testTransport.state.corners.every(p=>p.source==='restored')),true);
  assert.equal(writes.filter(url=>/\/(jog|goto|clearance-jog)$/.test(url)).length,actions);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(errors,[]);
  console.log('Surface recovery passed: inset grid, bounded Z up/down, stale plan invalidation, interrupted scan preview, confirmed XY-only restore, mobile layout; demo only.');
} finally { if(browser)await browser.close();if(server.exitCode===null){const stopped=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await stopped;} }
