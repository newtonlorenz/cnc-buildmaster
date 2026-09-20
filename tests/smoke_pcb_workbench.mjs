import {observeTransport,appearance} from './workbench_browser_helpers.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const artifacts=path.join(root,'output/playwright/pcb-workbench');
await mkdir(artifacts,{recursive:true});
const box='G21 G90 G17 G94 G54\nM5\nG0 Z5\nG0 X0 Y0\nM3 S1000\nG1 Z-0.1 F5\nG1 X10 F80\nY10\nX0\nY0\nG0 Z5\nG0 X-2 Y-2\nM5\nM2\n';
const server=spawn('python3',['scripts/cnc_map_web.py','--demo','--port','0'],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser,page;
try{
  const url=await new Promise((resolve,reject)=>{
    server.stdout.on('data',d=>{const match=String(d).match(/Open (http:\S+)/);if(match)resolve(match[1]);});
    server.once('exit',()=>reject(Error('Demo server exited')));
  });
  browser=await chromium.launch({channel:'chrome',headless:true});
  assert.notEqual(new URL(url).port,'8765','Use an isolated ephemeral demo port');
  page=await browser.newPage({viewport:{width:1440,height:1050},colorScheme:'light',reducedMotion:'reduce'});
  const errors=[],writes=[];page.on('pageerror',e=>errors.push(String(e)));
  page.on('request',r=>{if(r.method()==='POST')writes.push({action:r.url().split('/').at(-1),body:r.postDataJSON()});});
  await observeTransport(page);await page.goto(url);
  const pcb=page.locator('#pcbWorkspace');
  const stock=()=>pcb.getByRole('tab',{name:'Stock',exact:true}).click();
  const alignment=()=>pcb.getByRole('tab',{name:'Alignment',exact:true}).click();
  const review=()=>pcb.getByRole('tab',{name:'UGS draft',exact:true}).click();
  const idle=()=>page.waitForFunction(()=>{
    const {state,job,pending}=window.testTransport;
    return state&&job&&!pending&&!state.busy&&state.pcbRevision===job.revision&&!document.querySelector('#pcbImport')?.disabled;
  });
  async function action(id,endpoint){
    const response=page.waitForResponse(r=>r.url().endsWith('/api/'+endpoint)&&r.request().method()==='POST');
    await page.locator('#'+id).click();if(['pcbExample','pcbNew','pcbLoadSaved'].includes(id))await page.getByRole('button',{name:'Replace job',exact:true}).click();await response;await idle();
  }
  const painted=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  async function canvasImage(){await painted();return createHash('sha256').update(await page.locator('#pcbCanvas').evaluate(canvas=>canvas.toDataURL())).digest('hex');}
  const operation=name=>page.locator('.pcb-operation').filter({has:page.getByRole('heading',{name:new RegExp(name.replace('.','\\.'))})});
  await page.locator('#pcbTab').click();
  await page.locator('#pcbWorkspace').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('#pcbImport').disabled);
  assert.equal(await page.evaluate(()=>window.testTransport.state.demo),true);
  const files=['isolation.nc','drilling.nc','outline.nc'].map(name=>({name,mimeType:'text/plain',buffer:Buffer.from(box)}));
  await page.locator('#pcbFiles').setInputFiles(files);
  await page.waitForFunction(()=>document.querySelectorAll('.pcb-operation').length===3);
  await idle();
  // Saving a cutter must not discard independent, unapplied stock/reference edits.
  await page.locator('#pcbName').fill('Test board');
  await alignment();
  await page.locator('#pcbDesignX').fill('0');
  await page.locator('#pcbDesignY').fill('0');
  for(const name of files.map(f=>f.name)){
    const row=operation(name);
    await row.getByRole('textbox',{name:'Cutter for '+name,exact:true}).fill('Test '+name);
    await row.getByRole('spinbutton',{name:'Cutting diameter for '+name,exact:true}).fill('0.2');
  }
  for(const name of files.map(f=>f.name)){
    const row=operation(name);
    await row.getByRole('button',{name:'Save cutter',exact:true}).click();
    await idle();
    assert.equal(await operation('outline.nc').getByRole('textbox',{name:'Cutter for outline.nc',exact:true}).inputValue(),'Test outline.nc','Saving another cutter lost a queued operation draft');
  }
  assert.equal(await page.locator('#pcbDesignX').inputValue(),'0','Saving a cutter discarded reference edits');
  await stock();assert.equal(await page.locator('#pcbName').inputValue(),'Test board','Saving a cutter discarded stock edits');
  const beforeInvalid=writes.length;
  await page.locator('#pcbWidth').fill('');await page.locator('#pcbApply').click();
  assert.equal(await page.locator('#pcbWidth').evaluate(el=>el.validity.valueMissing),true);
  assert.equal(writes.length,beforeInvalid,'Incomplete setup reached the server');
  await page.locator('#pcbWidth').fill('100');await page.locator('#pcbMargin').fill('40');await page.locator('#pcbApply').click();
  await page.getByText('Edge margin must be non-negative and less than half the smaller stock dimension.',{exact:true}).first().waitFor();
  assert.equal(writes.length,beforeInvalid,'Invalid margin reached the server');
  await page.locator('#pcbMargin').fill('1');
  await page.locator('#pcbName').fill('Test board');await page.locator('#pcbPlaceX').fill('20');await page.locator('#pcbPlaceY').fill('20');
  if(!await page.locator('#pcbSave').isDisabled())throw Error('Unapplied placement could be saved');
  await action('pcbApply','pcb-configure');
  await page.waitForFunction(()=>document.querySelector('#pcbFit').textContent==='FITS DECLARED STOCK');
  // A settings change that pushes toolpaths outside stock is visibly rejected.
  await page.locator('#pcbPlaceX').fill('95');await action('pcbApply','pcb-configure');
  await page.waitForFunction(()=>document.querySelector('#pcbFit').textContent==='OUTSIDE STOCK');
  await page.locator('#pcbPlaceX').fill('20');await action('pcbApply','pcb-configure');
  await page.waitForFunction(()=>document.querySelector('#pcbFit').textContent==='FITS DECLARED STOCK');
  // Reordering preserves queued cutter edits; visibility and source checks are view-only.
  const drill=operation('drilling.nc');
  await drill.getByRole('textbox',{name:'Cutter for drilling.nc',exact:true}).fill('Queued drill');
  await drill.getByRole('button',{name:'up drilling.nc',exact:true}).click();await idle();
  assert.equal(await page.evaluate(()=>window.testTransport.job.operations[0].name),'drilling.nc');
  assert.equal(await drill.getByRole('textbox',{name:'Cutter for drilling.nc',exact:true}).inputValue(),'Queued drill');
  await drill.getByRole('button',{name:'down drilling.nc',exact:true}).click();await idle();
  await drill.getByRole('button',{name:'Save cutter',exact:true}).click();await idle();
  const beforeView=writes.length;
  await drill.getByRole('checkbox',{name:'Show drilling.nc',exact:true}).uncheck();
  await drill.getByRole('button',{name:'Source checks',exact:true}).click();
  const hash=await page.evaluate(()=>window.testTransport.job.operations.find(op=>op.name==='drilling.nc').sha256);
  assert.match(await drill.textContent(),new RegExp(hash));assert.match(await drill.textContent(),/initial approach/i);
  await drill.getByRole('checkbox',{name:'Show drilling.nc',exact:true}).check();
  const fitted=await canvasImage();
  await page.locator('#pcbZoomIn').click();assert.notEqual(await canvasImage(),fitted,'Zoom did not redraw');
  await page.locator('#pcbZoomFit').click();assert.equal(await canvasImage(),fitted,'Fit did not restore view');
  const canvas=await page.locator('#pcbCanvas').boundingBox();
  await page.mouse.move(canvas.x+canvas.width/2,canvas.y+canvas.height/2);await page.mouse.down();
  await page.mouse.move(canvas.x+canvas.width/2+45,canvas.y+canvas.height/2+30,{steps:5});await page.mouse.up();
  assert.notEqual(await canvasImage(),fitted,'Pan did not redraw');
  await page.locator('#pcbZoomFit').click();assert.equal(await canvasImage(),fitted);
  await page.locator('#pcbRapids').check();assert.notEqual(await canvasImage(),fitted,'Rapid travel toggle had no effect');await page.locator('#pcbRapids').uncheck();
  for(const plane of ['xz','yz','xy']){await page.locator('#pcbProjection').selectOption(plane);await painted();}
  assert.equal(writes.length,beforeView,'Preview issued a command');
  // Source (10,0), mirrored then rotated 90 degrees about (20,20), is machine (20,10).
  await page.locator('#pcbAngle').fill('90');await page.locator('#pcbMirror').check();await action('pcbApply','pcb-configure');
  await alignment();const beforePick=writes.length;await page.locator('#pcbPick').click();await painted();
  const bounds=await page.locator('#pcbCanvas').boundingBox(),scale=Math.min((bounds.width-80)/100,(bounds.height-80)/70);
  await page.locator('#pcbCanvas').click({position:{x:bounds.width/2+(20-50)*scale+2,y:bounds.height/2-(10-35)*scale}});
  assert.equal(Number(await page.locator('#pcbDesignX').inputValue()),10);assert.equal(Number(await page.locator('#pcbDesignY').inputValue()),0);
  assert.equal(writes.length,beforePick,'Point picking issued a command');
  await stock();await page.locator('#pcbAngle').fill('0');await page.locator('#pcbMirror').uncheck();await action('pcbApply','pcb-configure');
  // Three independent local drafts survive switching labels; C must reject a mismatch.
  await alignment();
  for(const [label,x,y,mx,my] of [['C',0,10,20,31],['B',10,0,30,20],['A',0,0,20,20]]){
    await page.locator('#pcbRefLabel').selectOption(label);
    for(const [id,value] of [['pcbDesignX',x],['pcbDesignY',y],['pcbMachineX',mx],['pcbMachineY',my]])await page.locator('#'+id).fill(String(value));
  }
  for(const [label,x] of [['A','0'],['B','10'],['C','0']]){
    await page.locator('#pcbRefLabel').selectOption(label);assert.equal(await page.locator('#pcbDesignX').inputValue(),x);
    await action('pcbReference','pcb-reference');
  }
  await action('pcbSolve','pcb-solve');await page.locator('.global-error').getByRole('button',{name:'Technical detail'}).click();await page.locator('#error').filter({hasText:'Independent point C misses'}).waitFor();
  assert.equal(await page.evaluate(()=>window.testTransport.job.canExport),false);
  await page.locator('#pcbMachineY').fill('30');await action('pcbReference','pcb-reference');await action('pcbSolve','pcb-solve');
  await page.waitForFunction(()=>document.querySelector('#pcbAlignmentResult').textContent.includes('Draft alignment'));
  await review();assert.equal(await page.locator('#pcbReviewed').isDisabled(),true);
  if(!await page.locator('#pcbExport').isDisabled())throw Error('Manual points allowed live export');
  // Only demo UI jogging is used to establish captured points.
  await page.locator('#surfaceTab').click();await page.locator('#attest').check();await page.locator('#arm').click();
  await page.locator('#teach').waitFor({state:'visible'});
  await page.locator('#jogMode').selectOption('step');
  await page.locator('#distance').selectOption('10');
  async function jog(axis,sign){
    const previous=await page.evaluate(axis=>window.testTransport.state.status.machineCoord[axis],axis);
    await page.locator('[data-axis="'+axis+'"][data-sign="'+sign+'"]').click();
    await page.waitForFunction(({axis,expected})=>!window.testTransport.pending&&!window.testTransport.state.busy&&Math.abs(window.testTransport.state.status.machineCoord[axis]-expected)<.0001,{axis,expected:previous+sign*10});
    await page.waitForFunction(()=>!document.querySelector('#distance').disabled);
  }
  await jog('x',1);await jog('x',1);await jog('y',1);await jog('y',1);
  for(const label of ['A','B','C']){
    if(label==='B')await jog('x',1);
    if(label==='C'){await jog('x',-1);await jog('y',1);}
    await page.locator('#pcbTab').click();await alignment();await page.locator('#pcbRefLabel').selectOption(label);await idle();
    const previous=await page.evaluate(()=>window.testTransport.state.status.machineCoord);
    await action('pcbCapture','pcb-capture');
    assert.deepEqual(await page.evaluate(()=>window.testTransport.state.status.machineCoord),previous,'Capture moved the cutter');
    assert.equal('machine' in writes.findLast(write=>write.action==='pcb-capture').body,false,'Capture sent typed machine XY');
    assert.deepEqual(await page.evaluate(label=>window.testTransport.job.references[label].machine,label),[previous.x,previous.y]);
    if(label!=='C')await page.locator('#surfaceTab').click();
  }
  // PCB canvas keys never silently jog the hidden machine controls.
  const beforeKeys=writes.length;
  await page.getByRole('heading',{name:'Toolpath preview',exact:true}).click();await page.keyboard.press('ArrowRight');await page.keyboard.press('PageUp');
  await page.waitForTimeout(850);
  assert.equal(writes.length,beforeKeys,'PCB keys issued a command');
  if(await page.locator('#status-x').textContent()!=='20.000')throw Error('PCB keyboard input moved the machine');
  await action('pcbSolve','pcb-solve');
  await page.waitForFunction(()=>document.querySelector('#pcbAlignmentResult').textContent.includes('Captured alignment'));
  await review();await page.locator('#pcbReviewed').check();
  await page.waitForFunction(()=>!document.querySelector('#pcbExport').disabled);
  await stock();await page.locator('#pcbName').fill('Edited after review');await review();
  assert.equal(await page.locator('#pcbExport').isDisabled(),true);assert.equal(await page.locator('#pcbReviewed').isChecked(),false);
  await stock();await pcb.getByRole('button',{name:'Discard setup edits',exact:true}).click();await review();
  assert.equal(await page.locator('#pcbReviewed').isChecked(),false,'Discarding edits restored export consent');
  await page.locator('#pcbReviewed').check();
  const draftDownload=page.waitForEvent('download');await action('pcbExport','pcb-export');
  await (await draftDownload).saveAs(path.join(artifacts,'simulated-aligned-draft.zip'));
  const packageDownload=page.waitForEvent('download');await action('pcbSave','pcb-save');
  const savedPackage=JSON.parse(await readFile(await (await packageDownload).path(),'utf8'));
  if(savedPackage.executionReleased!==false||savedPackage.files.length!==3)throw Error('Invalid saved package');
  assert.equal(savedPackage.heightCompensationAddedByWorkbench,false);
  if(JSON.stringify(savedPackage).includes(url.split('#')[1]))throw Error('Authentication token leaked in package');
  await page.waitForFunction(()=>!document.querySelector('#pcbImport').disabled);
  await page.screenshot({path:path.join(artifacts,'aligned-desktop.png'),fullPage:true});
  // Reopen preserves jobs but discards all physical alignment claims.
  await stock();await page.locator('#pcbName').fill('Old job local draft');
  await page.locator('#pcbPackageFile').setInputFiles({name:'job.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(savedPackage))});
  await page.getByRole('button',{name:'Replace job',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#pcbStatus').textContent.includes('Previous machine references'));
  await idle();assert.equal(await page.locator('#pcbName').inputValue(),'Test board','Replaced job retained stale stock edits');
  await alignment();assert.match(await page.locator('#pcbReferenceTable').textContent(),/Not captured/);
  await review();assert.equal(await page.locator('#pcbExport').isDisabled(),true,'Restored package reused alignment');
  assert.equal(await page.evaluate(()=>Object.values(window.testTransport.job.references).every(point=>point.machine===null&&point.session===null)),true);
  // Parser errors preserve the existing job.
  await page.locator('#pcbFiles').setInputFiles({name:'invalid.nc',mimeType:'text/plain',buffer:Buffer.from('G53 G0 X0 Y0')});
  await page.locator('.global-error').getByRole('button',{name:'Technical detail'}).click();
  await page.locator('#error').filter({hasText:'Unsupported G-code'}).waitFor();
  if(await page.locator('.pcb-operation').count()!==3)throw Error('Invalid import lost the current job');
  await idle();await operation('outline.nc').getByRole('button',{name:'remove outline.nc',exact:true}).click();await idle();
  assert.equal(await page.locator('.pcb-operation').count(),2);assert.equal(await page.evaluate(()=>window.testTransport.job.alignment),null);
  await action('pcbExample','pcb-example');
  await page.waitForFunction(()=>document.querySelectorAll('.pcb-operation').length===1);
  await page.waitForFunction(()=>!document.querySelector('#pcbImport').disabled);
  await stock();
  await page.screenshot({path:path.join(artifacts,'example-desktop.png'),fullPage:true});
  await appearance(page,'dark');await painted();await page.screenshot({path:path.join(artifacts,'example-dark.png'),fullPage:true});
  await page.setViewportSize({width:1024,height:768});await painted();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Compact horizontal overflow');
  assert.equal(await page.locator('.toolpath-preview').evaluate(element=>{
    const bounds=element.getBoundingClientRect(),hint=element.querySelector('#pcbPreviewHint').getBoundingClientRect();
    return hint.bottom<=bounds.bottom+1;
  }),true,'Compact preview clipped its coordinate and interaction explanation');
  await page.screenshot({path:path.join(artifacts,'example-compact.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await painted();
  await page.screenshot({path:path.join(artifacts,'example-mobile.png'),fullPage:true});
  await page.screenshot({path:path.join(artifacts,'example-mobile-viewport.png')});
  const canvasBounds=await page.locator('#pcbCanvas').boundingBox(),operationsBounds=await page.locator('#pcbOperations').boundingBox();
  if(canvasBounds.y>=operationsBounds.y)throw Error('Mobile preview follows operations instead of leading the workspace');
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile horizontal overflow');
  await page.locator('#stop').click();
  await page.waitForFunction(()=>window.testTransport.state.phase==='stopped');
  if(await page.locator('.pcb-operation').count()!==1)throw Error('Stop discarded the job');
  await page.setViewportSize({width:1440,height:1050});await page.locator('#surfaceTab').click();await page.locator('#recovery').waitFor({state:'visible'});
  if(errors.length)throw Error(errors.join('\n'));
  console.log('PCB browser passed: import/source rejection, independent drafts, stock validation/fit, operation order/visibility/removal, source hashes, XYZ/pan/zoom, mirror/rotation picking, independent C rejection, manual/captured alignment, capture/keyboard no-motion, guarded simulated export, package restore, desktop/dark/compact/mobile and Stop. Demo only; no hardware.');
}catch(error){
  if(page)await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true}).catch(()=>{});
  throw error;
}finally{
  if(browser)await browser.close();
  if(server.exitCode===null){const ended=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await ended;}
}
