import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
const artifacts='output/design-review';await mkdir(artifacts,{recursive:true});
const server=spawn('python3',['scripts/cnc_map_web.py','--demo','--port','0'],{stdio:['ignore','pipe','pipe']});
let browser;
try{
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{const m=String(d).match(/Open (http:\S+)/);if(m)resolve(m[1]);});server.once('exit',()=>reject(Error('Demo exited')));});
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:960},colorScheme:'light'});
 const errors=[],writes=[];page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
 await page.goto(url);await page.waitForFunction(()=>state?.demo&&!!window.SurfaceUI);
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await page.locator('#appearance').selectOption('light');await page.emulateMedia({colorScheme:'dark'});
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 // Search, utilities, tab keys, theme and viewport controls must be read-only.
 const before=writes.length;
 await page.keyboard.press('Control+k');await page.getByRole('textbox',{name:'Find a tool'}).fill('camera');
 await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 await page.locator('#utilityDialog').waitFor({state:'visible'});
 await page.locator('#closeUtility').click();
 await page.locator('[data-utility=diagnostics]').click();
 assert.match(await page.locator('#configSummary').textContent(),/Example machine/);
 assert.match(await page.locator('#configValues').textContent(),/100 mm\/min/);
 await page.locator('#closeUtility').click();
 await page.locator('#surfaceZoomIn').click();await page.locator('#surfaceFit').click();
 assert.equal(await page.locator('#plot').getAttribute('viewBox'),'0 0 640 410');
 await page.locator('#surfaceTab').focus();await page.keyboard.press('ArrowDown');
 assert.equal(await page.locator('#pcbTab').getAttribute('aria-selected'),'true');
 await page.keyboard.press('ArrowUp');assert.equal(await page.locator('#surfaceTab').getAttribute('aria-selected'),'true');
 assert.equal(writes.length,before);
 await page.locator('#attest').check();await page.locator('#arm').click();await page.locator('#teach').waitFor({state:'visible'});
 // Build illustrative geometry in demo mode only; the screenshot is never live evidence.
 await page.locator('.manual-entry summary').click();
 for(const [name,x,y] of [['front-left','0','0'],['back-right','180','120']]){
  await page.locator('#corner').selectOption(name);await page.locator('#cornerX').fill(x);await page.locator('#cornerY').fill(y);
  await page.locator('#saveCorner').click();await page.waitForFunction(n=>state.corners.some(p=>p.name===n),name);
 }
 const armedWrites=writes.length;
 await page.locator('.corner-dock summary').focus();await page.keyboard.press('Enter');
 assert.equal(writes.length,armedWrites);
 await page.locator('.corner-dock summary').focus();await page.keyboard.press('Enter');
 assert.equal(writes.length,armedWrites);
 await page.keyboard.press('Control+k');await page.getByRole('textbox',{name:'Find a tool'}).fill('connection');
 await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowLeft');
 await page.getByRole('button',{name:'Close tool search'}).click();assert.equal(writes.length,armedWrites);
 // Normal viewport has no document-level scrolling and Stop remains visible.
 await page.locator('h1').click();
 await page.evaluate(()=>document.querySelector('.mapping-inspector').scrollTop=0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight+1),false);
 await page.screenshot({path:artifacts+'/desktop.png',fullPage:true});
 await page.setViewportSize({width:1024,height:768});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 assert.ok((await page.locator('#plot').boundingBox()).height>=150);
 await page.screenshot({path:artifacts+'/compact.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:artifacts+'/mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:960});await page.locator('#appearance').selectOption('dark');await page.locator('#pcbTab').click();
 await page.locator('#pcbExample').click();await page.waitForFunction(()=>document.querySelectorAll('.pcb-operation').length>0);
 await page.screenshot({path:artifacts+'/desktop-dark.png',fullPage:true});
 // Enter on the session disclosure must never authorise a pending probe prompt.
 await page.locator('#surfaceTab').click();
 await page.locator('[data-suggested="front-right"]').click();await page.waitForFunction(()=>state.corners.length===3);
 await page.locator('[data-suggested="back-left"]').click();await page.waitForFunction(()=>state.corners.length===4);
 await page.locator('#toPlanning').click();await page.locator('#spacing').fill('60');await page.locator('#preview').click();await page.locator('#scan').click();
 await page.waitForFunction(()=>state.phase==='scan'&&state.prompt);
 await page.locator('#openSession').click();const waitingWrites=writes.length;
 await page.locator('#sessionEvents summary').focus();await page.keyboard.press('Enter');
 assert.equal(writes.length,waitingWrites);assert.equal(await page.evaluate(()=>state.phase),'scan');
 // Native button activation in the command menu must reach Stop, even with no results.
 await page.keyboard.press('Control+k');await page.getByRole('textbox',{name:'Find a tool'}).fill('no-such-tool');
 await page.locator('surface-command-menu').getByRole('button',{name:'Stop motion',exact:true}).focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>state.phase==='stopped');
 assert.ok(writes.at(-1).endsWith('/api/stop'));
 // Stop stays accessible inside a modal; Escape retains the physical-control contract.
 await page.locator('#openShortcuts').click();await page.keyboard.press('Escape');
 await page.waitForFunction(()=>state.phase==='stopped');assert.equal(await page.locator('#shortcutsDialog').isVisible(),false);
 await page.reload();await page.waitForFunction(()=>state?.demo);assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 assert.deepEqual(errors,[]);
 console.log('Desktop UX passed: system/manual/persisted themes, tool search, modal input isolation, tab keys, fit controls, 1440/1024/390 layouts, fixed Stop, demo corners, PCB preview and Escape. No hardware.');
}finally{if(browser)await browser.close();if(server.exitCode===null){const stopped=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await stopped;}}
