import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile} from 'node:fs/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const artifacts=path.join(root,'output/playwright/cnc-workbench');
await mkdir(artifacts,{recursive:true});
const server=spawn('python3',['scripts/cnc_map_web.py','--demo','--port','0'],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser;
try{
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{const m=String(d).match(/Open (http:\S+)/);if(m)resolve(m[1]);});server.once('exit',()=>reject(Error('Server exited')));});
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(url);
 await page.locator('#surfaceTab').click();
 await page.route('**/api/state',async route=>{
   const response=await route.fetch(),body=await response.json();
   await route.fulfill({response,json:{...body,apiVersion:1}});
 });
 await page.waitForFunction(()=>document.querySelector('#error').textContent.includes('server needs the current app version'));
 if(!await page.locator('#checkConnection').isDisabled())throw Error('Old server version left controls enabled');
 await page.unroute('**/api/state');
 await page.waitForFunction(()=>document.querySelector('#error').hidden&&!document.querySelector('#checkConnection').disabled);
 await page.locator('[data-utility=diagnostics]').click();
 await page.locator('#checkConnection').click();
 await page.waitForFunction(()=>document.querySelector('#health').textContent.includes('Demo · no machine access'));
 await page.locator('#closeUtility').click();
 await page.locator('[data-utility=camera]').click();
 // Chrome provides a generated video stream: no physical camera is opened.
 await page.locator('#cameraStart').click();
 await page.waitForFunction(()=>document.querySelector('#cameraState').textContent==='LIVE');
 await page.evaluate(()=>{window.testCameraTrack=document.querySelector('#cameraVideo').srcObject.getVideoTracks()[0];});
 await page.locator('#cameraStop').click();
 await page.waitForFunction(()=>window.testCameraTrack.readyState==='ended'&&document.querySelector('#cameraFrame').hidden);
 // Cancel a permission request that resolves late. Its tracks must be released.
 await page.evaluate(()=>{
   window.originalGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{window.resolveCamera=resolve;});
 });
 await page.locator('#cameraStart').click();
 await page.waitForFunction(()=>document.querySelector('#cameraState').textContent==='WAITING');
 await page.locator('#cameraStop').click();
 await page.evaluate(()=>{
   const canvas=document.createElement('canvas'),stream=canvas.captureStream();
   window.lateTrack=stream.getVideoTracks()[0];window.resolveCamera(stream);
 });
 await page.waitForFunction(()=>window.lateTrack.readyState==='ended'&&document.querySelector('#cameraState').textContent==='OFF');
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');};});
 await page.locator('#cameraStart').click();
 await page.waitForFunction(()=>document.querySelector('#cameraHelp').textContent.includes('permission was denied'));
 await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=window.originalGetUserMedia;});
 await page.locator('#closeUtility').click();
 await page.locator('#attest').check();
 await page.locator('#arm').click();
 await page.locator('#teach').waitFor({state:'visible'});
 const heldRequests=[];
 page.on('request',r=>{if(r.url().endsWith('/api/jog-hold'))heldRequests.push(r.postDataJSON());});
 await page.locator('#speed').selectOption('maximum');
 await page.locator('#jogMode').selectOption('hold');
 await page.locator('h1').click();
 await page.keyboard.down('ArrowRight');
 await page.waitForFunction(()=>Number(document.querySelector('#x').textContent)>=3);
 await page.keyboard.up('ArrowRight');
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');
 await page.locator('#speed').selectOption('normal');
 await page.locator('#fastHold').check();
 await page.locator('h1').click();
 await page.keyboard.down('ArrowRight');
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='Operation in progress');
 await page.keyboard.up('ArrowRight');
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');
 if(heldRequests.at(-1).speed!=='maximum')throw Error('Fast XY hold did not use controller maximum');
 await page.locator('#fastHold').uncheck();
 await page.locator('h1').click();
 await page.keyboard.down('Shift');await page.keyboard.down('ArrowLeft');
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='Operation in progress');
 await page.keyboard.up('ArrowLeft');await page.keyboard.up('Shift');
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');
 if(heldRequests.at(-1).speed!=='maximum')throw Error('Shift+arrow did not start maximum XY hold');
 await page.locator('#fastHold').check();
 await page.locator('h1').click();
 await page.keyboard.down('Shift');await page.keyboard.down('PageUp');
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='Operation in progress');
 await page.keyboard.up('PageUp');await page.keyboard.up('Shift');
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');
 if(heldRequests.at(-1).axis!=='z'||heldRequests.at(-1).speed!=='normal')throw Error('Fast XY hold changed Z speed');
 await page.locator('#fastHold').uncheck();
 const stoppedX=await page.locator('#x').textContent();
 await page.waitForTimeout(650);
 if(await page.locator('#x').textContent()!==stoppedX)throw Error('Released held jog restarted');
 await page.locator('h1').click();
 await page.keyboard.down('ArrowLeft');
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='Operation in progress');
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
 await page.keyboard.up('ArrowLeft');
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');
 await page.locator('#jogMode').selectOption('step');
 await page.locator('#speed').selectOption('normal');
 async function jog(axis,sign){const b=page.locator(`[data-axis="${axis}"][data-sign="${sign}"]`);await b.click();await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');}
 async function capture(corner){await page.locator('#corner').selectOption(corner);await page.locator('#capture').click();await page.waitForFunction(()=>!document.querySelector('#capture').disabled);}
 // Begin at the back-right, then capture the others in a deliberately different order.
 await capture('back-right');
 if(await page.locator('#corner').inputValue()!=='front-left')throw Error('Opposite corner was not suggested');
 await page.locator('#distance').selectOption('5');
 await jog('x',-1);await jog('y',-1);await capture('front-left');
 await page.locator('#corner').selectOption('front-right');await page.locator('#gotoCorner').click();
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');await capture('front-right');
 await page.locator('#corner').selectOption('back-left');await page.locator('#gotoCorner').click();
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');await capture('back-left');
 await page.locator('#toPlanning').waitFor({state:'visible'});
 await page.locator('#clickMove').check();
 const box=await page.locator('#plot').boundingBox();
 const beforeX=Number(await page.locator('#x').textContent()),beforeY=Number(await page.locator('#y').textContent());
 const centre=await page.locator('#plot').evaluate(svg=>{const p=svg.createSVGPoint();p.x=320;p.y=205;const q=p.matrixTransform(svg.getScreenCTM());return {x:q.x,y:q.y,tolerance:1/(Math.abs(svg.getScreenCTM().d)*plotTransform.scale)};});
 await page.mouse.click(centre.x,centre.y);
 await page.waitForFunction(x=>Number(document.querySelector('#x').textContent)===x,beforeX+2.5);
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');
 if(Math.abs(Number(await page.locator('#y').textContent())-(beforeY-2.5))>Math.max(.002,centre.tolerance))throw Error('Map target transform incorrect: '+JSON.stringify({beforeX,beforeY,x:await page.locator('#x').textContent(),y:await page.locator('#y').textContent(),box}));
 await page.mouse.click(box.x+10,box.y+10);
 await page.waitForFunction(()=>document.querySelector('#error').textContent.includes('inside the taught rectangle'));
 await page.locator('#corner').selectOption('back-left');await page.locator('#gotoCorner').click();
 await page.waitForFunction(x=>Number(document.querySelector('#x').textContent)===x,beforeX);
 await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');
 await page.locator('#toPlanning').click();
 await page.locator('#planning').waitFor({state:'visible'});
 await page.locator('#spacing').fill('2.5');
 await page.locator('#preview').click();
 await page.locator('#planSummary').waitFor({state:'visible'});
 if(await page.locator('[data-route="scan"]').count()!==1||await page.locator('[data-route="return"]').count()!==1)throw Error('Scan route preview missing');
 if(!(await page.locator('#planText').textContent()).includes('10 puck placements'))throw Error('Placement count missing return');
 await page.locator('#spacing').fill('1');
 if(!await page.locator('#scan').isDisabled())throw Error('Changed spacing allowed stale scan');
 await page.locator('#spacing').fill('2.5');
 if(await page.locator('#scan').isDisabled())throw Error('Matching preview failed to re-enable scan');
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:path.join(artifacts,'desktop.png'),fullPage:true});
 await page.locator('#scan').click();
 await page.locator('#measurement').waitFor({state:'visible'});
 for(let i=0;i<13;i++){
  const b=page.locator('#ready');await b.click();
  if(i<12)await page.waitForFunction(()=>!document.querySelector('#ready').disabled);
 }
 await page.locator('#finished').waitFor({state:'visible'});
 if(await page.locator('#scanProgress').getAttribute('value')!=='10')throw Error('Full progress not recorded');
 await page.locator('[data-utility=diagnostics]').click();
 const downloaded=page.waitForEvent('download');
 await page.locator('#report').click();
 const report=JSON.parse(await readFile(await (await downloaded).path(),'utf8'));
 if(report.measurements.length!==10||!report.measurements.every(m=>m.simulated))throw Error('Demo report is not explicit about simulated readings');
 if(JSON.stringify(report).includes(url.split('#')[1]))throw Error('Session report leaked authentication token');
 await page.locator('#closeUtility').click();
 await page.locator('#newMap').click();
 await page.locator('#setup').waitFor({state:'visible'});
 if(await page.locator('#attest').isChecked()||!await page.locator('#arm').isDisabled())throw Error('Fresh setup retained operator confirmation');
 if(!(await page.locator('#cornerTable').textContent()).includes('Not recorded'))throw Error('Fresh setup retained corners');
 await page.locator('#attest').check();await page.locator('#arm').click();
 await page.locator('#teach').waitFor({state:'visible'});
 // Enter on the Stop button must stop, never record a corner.
 await page.locator('#stop').focus();await page.keyboard.press('Enter');
 await page.locator('#recovery').waitFor({state:'visible'});
 await page.locator('#fresh').click();
 await page.locator('#setup').waitFor({state:'visible'});
 await page.locator('#attest').check();await page.locator('#arm').click();
 await page.locator('#teach').waitFor({state:'visible'});
 await page.locator('summary').filter({hasText:'Enter selected corner'}).click();
 const movement=[];page.on('request',r=>{if(/\/api\/(goto|jog|jog-hold)$/.test(r.url()))movement.push(r.url());});
 for(const [corner,x,y] of [['front-left','0','0'],['back-right','10','10']]){
   await page.locator('#corner').selectOption(corner);
   await page.locator('#cornerX').fill(x);await page.locator('#cornerY').fill(y);
   await page.locator('#saveCorner').click();
   await page.waitForFunction(n=>state.corners.some(p=>p.name===n),corner);
 }
 await page.screenshot({path:path.join(artifacts,'suggested-corners.png'),fullPage:true});
 // Suggestions take priority over movement, even when click-to-move is enabled.
 await page.locator('#clickMove').check();
 await page.locator('[data-suggested="front-right"]').click();
 await page.waitForFunction(()=>state.corners.length===3);
 await page.locator('[data-suggested="back-left"]').focus();
 // A state refresh redraws SVG; keep keyboard focus on the same suggestion.
 await page.evaluate(()=>render());
 if(!await page.locator('[data-suggested="back-left"]').evaluate(e=>document.activeElement===e))throw Error('Refresh lost suggestion focus');
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>state.corners.length===4);
 if(movement.length)throw Error('Accepting coordinates issued a movement');
 if(await page.locator('[data-suggested]').count())throw Error('Accepted suggestions remain provisional');
 if(!(await page.locator('#cornerTable').textContent()).includes('entered'))throw Error('Entered provenance missing');
 if(errors.length)throw Error(errors.join('\n'));
 console.log('Browser passed: diagnostics, camera start/stop/late permission/denial with fake video, arbitrary corners and opposite guidance, map click/rejection, held jog/release/blur, maximum speed, route/spacing/progress, single-use prompts, simulated report, fresh setup and keyboard Stop; no hardware.');
 await page.locator('#stop').click();
 await page.waitForFunction(()=>document.querySelector('#operation').textContent.startsWith('Stopped'));
 await page.setViewportSize({width:390,height:844});
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile horizontal overflow');
 await page.screenshot({path:path.join(artifacts,'mobile.png'),fullPage:true});
}finally{
 if(browser)await browser.close();
 if(server.exitCode===null){const stopped=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await stopped;}
}
