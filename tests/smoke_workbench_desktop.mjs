import {observeTransport,appearance,openUtility,closeUtility} from './workbench_browser_helpers.mjs';
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
 const errors=[],writes=[];page.on('console',message=>{if(message.type()==='error'&&/Content Security Policy|Refused to/.test(message.text()))errors.push(message.text())});page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
 await observeTransport(page);await page.goto(url);await page.locator('#surfaceTab').click();await page.waitForFunction(()=>window.testTransport.state?.demo);
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await appearance(page,'light');await page.emulateMedia({colorScheme:'dark'});
 assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
 // Search, utilities, tab keys, theme and viewport controls must be read-only.
 const before=writes.length;
 await page.keyboard.press('Control+k');await page.getByPlaceholder('Search tools…').fill('camera');
 await page.getByRole('option',{name:'Camera preview',exact:true}).click();
 await page.getByRole('dialog').waitFor({state:'visible'});
 await closeUtility(page);
 await openUtility(page,'Connection');
 assert.match(await page.getByRole('dialog').textContent(),/Example machine/);
 assert.match(await page.getByRole('dialog').textContent(),/100 mm\/min/);
 await closeUtility(page);
 await page.locator('#surfaceZoomIn').click();await page.locator('#surfaceFit').click();
 assert.equal(await page.locator('#plot').getAttribute('viewBox'),'0 0 640 410');
 await page.locator('#pcbTab').focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('#pcbTab').getAttribute('data-active'),'true');
 await page.locator('#surfaceTab').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#surfaceTab').getAttribute('data-active'),'true');
 assert.equal(writes.length,before);
 await page.locator('#attest').check();await page.locator('#arm').click();await page.locator('#teach').waitFor({state:'visible'});
 // Build illustrative geometry in demo mode only; the screenshot is never live evidence.
 await page.getByRole('button',{name:'Enter selected corner coordinates'}).click();
 for(const [name,x,y] of [['front-left','0','0'],['back-right','180','120']]){
  await page.locator('#corner').selectOption(name);await page.locator('#cornerX').fill(x);await page.locator('#cornerY').fill(y);
  await page.locator('#saveCorner').click();await page.waitForFunction(n=>window.testTransport.state.corners.some(p=>p.name===n),name);
 }
 const armedWrites=writes.length;
 await page.getByRole('button',{name:'Corner coordinates · machine XY, mm'}).focus();await page.keyboard.press('Enter');
 assert.equal(writes.length,armedWrites);
 await page.getByRole('button',{name:'Corner coordinates · machine XY, mm'}).focus();await page.keyboard.press('Enter');
 assert.equal(writes.length,armedWrites);
 await page.keyboard.press('Control+k');await page.getByPlaceholder('Search tools…').fill('connection');
 await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowLeft');
 await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();assert.equal(writes.length,armedWrites);
 // Normal viewport has no document-level scrolling and Stop remains visible.
 await page.locator('#surfaceWorkspace h1').click();
 await page.evaluate(()=>document.querySelector('.surface-inspector').scrollTop=0);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight+1),false);
 await page.evaluate(()=>document.querySelector('#surfaceWorkspace').scrollTop=0);
 await page.screenshot({path:artifacts+'/desktop.png',fullPage:true});
 await page.setViewportSize({width:1024,height:768});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 assert.ok((await page.locator('#plot').boundingBox()).height>=150);
 await page.screenshot({path:artifacts+'/compact.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:artifacts+'/mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:960});await appearance(page,'dark');await page.locator('#pcbTab').click();
 await page.locator('#pcbExample').click();await page.waitForFunction(()=>document.querySelectorAll('.pcb-operation').length>0);
 await page.screenshot({path:artifacts+'/desktop-dark.png',fullPage:true});
 // Enter on the session disclosure must never authorise a pending probe prompt.
 await page.locator('#surfaceTab').click();
 await page.locator('[data-suggested="front-right"]').click();await page.waitForFunction(()=>window.testTransport.state.corners.length===3);
 await page.locator('[data-suggested="back-left"]').click();await page.waitForFunction(()=>window.testTransport.state.corners.length===4);
 await page.locator('#toPlanning').click();await page.locator('#spacing').fill('60');await page.locator('#preview').click();await page.locator('#scan').click();
 await page.waitForFunction(()=>window.testTransport.state.phase==='scan'&&window.testTransport.state.prompt);
 await openUtility(page,'Session log');const waitingWrites=writes.length;
 await page.locator('#log').focus();await page.keyboard.press('Enter');
 assert.equal(writes.length,waitingWrites);assert.equal(await page.evaluate(()=>window.testTransport.state.phase),'scan');
 await closeUtility(page);
 // Native button activation in the command menu must reach Stop, even with no results.
 await page.keyboard.press('Control+k');await page.getByPlaceholder('Search tools…').fill('no-such-tool');
 await page.getByRole('dialog').getByRole('button',{name:/^Stop/}).focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.testTransport.state.phase==='stopped');
 assert.ok(writes.at(-1).endsWith('/api/stop'));
 // Stop stays accessible inside a modal; Escape retains the physical-control contract.
 await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();await openUtility(page,'Keyboard shortcuts');await page.keyboard.press('Escape');
 await page.waitForFunction(()=>window.testTransport.state.phase==='stopped');assert.equal(await page.getByRole('dialog').isVisible(),false);
 await page.reload();await page.waitForFunction(()=>window.testTransport.state?.demo);assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 assert.equal(await page.locator('job-workbench,surface-icon,surface-command-menu').count(),0);
 assert.equal(await page.locator('button:not([data-slot]):not([data-sidebar])').count(),0);
 assert.deepEqual(errors,[]);
 console.log('Desktop UX passed: system/manual/persisted themes, tool search, modal input isolation, tab keys, fit controls, 1440/1024/390 layouts, fixed Stop, demo corners, PCB preview and Escape. No hardware.');
}finally{if(browser)await browser.close();if(server.exitCode===null){const stopped=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await stopped;}}
