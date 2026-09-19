import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const artifacts=path.join(root,'output/playwright/pcb-workbench');
await mkdir(artifacts,{recursive:true});
const box='G21 G90 G17 G94 G54\nM5\nG0 Z5\nG0 X0 Y0\nM3 S1000\nG1 Z-0.1 F20\nG1 X10 F80\nY10\nX0\nY0\nG0 Z5\nM5\nM2\n';
const server=spawn('python3',['scripts/cnc_map_web.py','--demo','--port','0'],{cwd:root,stdio:['ignore','pipe','pipe']});
let browser;
try{
  const url=await new Promise((resolve,reject)=>{
    server.stdout.on('data',d=>{const match=String(d).match(/Open (http:\S+)/);if(match)resolve(match[1]);});
    server.once('exit',()=>reject(Error('Demo server exited')));
  });
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1050}});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(url);
  await page.locator('#pcbTab').click();
  await page.locator('#pcbWorkspace').waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('#pcbImport').disabled);
  const files=['isolation.nc','drilling.nc','outline.nc'].map(name=>({name,mimeType:'text/plain',buffer:Buffer.from(box)}));
  await page.locator('#pcbFiles').setInputFiles(files);
  await page.waitForFunction(()=>document.querySelectorAll('.pcb-operation').length===3);
  // Saving a cutter must not discard independent, unapplied stock/reference edits.
  await page.locator('#pcbName').fill('Test board');
  await page.locator('#pcbDesignX').fill('0');
  await page.locator('#pcbDesignY').fill('0');
  for(const name of files.map(f=>f.name)){
    const row=page.locator('.pcb-operation').filter({has:page.getByRole('heading',{name:new RegExp(name.replace('.','\\.'))})});
    await row.getByRole('textbox',{name:'Cutter for '+name,exact:true}).fill('Test '+name);
    await row.getByRole('spinbutton',{name:'Cutting diameter for '+name,exact:true}).fill('0.2');
    await row.getByRole('button',{name:'Save cutter',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#pcbImport').disabled);
  }
  if(await page.locator('#pcbName').inputValue()!=='Test board'||await page.locator('#pcbDesignX').inputValue()!=='0')throw Error('Saving a cutter discarded other form edits');
  await page.locator('#pcbName').fill('Test board');await page.locator('#pcbPlaceX').fill('20');await page.locator('#pcbPlaceY').fill('20');
  if(!await page.locator('#pcbSave').isDisabled())throw Error('Unapplied placement could be saved');
  await page.locator('#pcbApply').click();
  await page.waitForFunction(()=>document.querySelector('#pcbFit').textContent==='FITS DECLARED STOCK');
  // A settings change that pushes toolpaths outside stock is visibly rejected.
  await page.locator('#pcbPlaceX').fill('95');await page.locator('#pcbApply').click();
  await page.waitForFunction(()=>document.querySelector('#pcbFit').textContent==='OUTSIDE STOCK');
  await page.locator('#pcbPlaceX').fill('20');await page.locator('#pcbApply').click();
  await page.waitForFunction(()=>document.querySelector('#pcbFit').textContent==='FITS DECLARED STOCK');
  // Manual point entry permits offline planning but never live export.
  for(const [label,x,y,mx,my] of [['A',0,0,20,20],['B',10,0,30,20],['C',0,10,20,30]]){
    await page.locator('#pcbRefLabel').selectOption(label);
    for(const [id,value] of [['pcbDesignX',x],['pcbDesignY',y],['pcbMachineX',mx],['pcbMachineY',my]])await page.locator('#'+id).fill(String(value));
    await page.locator('#pcbReference').click();
    await page.waitForFunction(()=>!document.querySelector('#pcbImport').disabled);
  }
  await page.locator('#pcbSolve').click();
  await page.waitForFunction(()=>document.querySelector('#pcbAlignmentResult').textContent.includes('Draft alignment'));
  await page.locator('#pcbReviewed').check();
  if(!await page.locator('#pcbExport').isDisabled())throw Error('Manual points allowed live export');
  // Only demo UI jogging is used to establish captured points.
  await page.locator('#surfaceTab').click();await page.locator('#attest').check();await page.locator('#arm').click();
  await page.locator('#teach').waitFor({state:'visible'});
  await page.locator('#distance').selectOption('10');
  async function jog(axis,sign){
    await page.locator('[data-axis="'+axis+'"][data-sign="'+sign+'"]').click();
    await page.waitForFunction(()=>document.querySelector('#operation').textContent==='teach');
  }
  await jog('x',1);await jog('x',1);await jog('y',1);await jog('y',1);
  for(const label of ['A','B','C']){
    if(label==='B')await jog('x',1);
    if(label==='C'){await jog('x',-1);await jog('y',1);}
    await page.locator('#pcbTab').click();await page.locator('#pcbRefLabel').selectOption(label);
    await page.locator('#pcbCapture').click();
    await page.waitForFunction(()=>!document.querySelector('#pcbImport').disabled);
    if(label!=='C')await page.locator('#surfaceTab').click();
  }
  // PCB canvas keys never silently jog the hidden machine controls.
  await page.locator('h1').click();await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(850);
  if(await page.locator('#x').textContent()!=='20.000')throw Error('PCB keyboard input moved the machine');
  await page.locator('#pcbSolve').click();
  await page.waitForFunction(()=>document.querySelector('#pcbAlignmentResult').textContent.includes('Captured alignment'));
  await page.locator('#pcbReviewed').check();
  await page.waitForFunction(()=>!document.querySelector('#pcbExport').disabled);
  const draftDownload=page.waitForEvent('download');await page.locator('#pcbExport').click();
  await (await draftDownload).saveAs(path.join(artifacts,'simulated-aligned-draft.zip'));
  const packageDownload=page.waitForEvent('download');await page.locator('#pcbSave').click();
  const savedPackage=JSON.parse(await readFile(await (await packageDownload).path(),'utf8'));
  if(savedPackage.executionReleased!==false||savedPackage.files.length!==3)throw Error('Invalid saved package');
  if(JSON.stringify(savedPackage).includes(url.split('#')[1]))throw Error('Authentication token leaked in package');
  await page.waitForFunction(()=>!document.querySelector('#pcbImport').disabled);
  await page.screenshot({path:path.join(artifacts,'aligned-desktop.png'),fullPage:true});
  // Reopen preserves jobs but discards all physical alignment claims.
  await page.locator('#pcbPackageFile').setInputFiles({name:'job.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(savedPackage))});
  await page.waitForFunction(()=>document.querySelector('#pcbStatus').textContent.includes('Previous machine references'));
  if(!(await page.locator('#pcbReferenceTable').textContent()).includes('not captured')||!await page.locator('#pcbExport').isDisabled())throw Error('Restored package reused live alignment');
  // Parser errors preserve the existing job.
  await page.locator('#pcbFiles').setInputFiles({name:'invalid.nc',mimeType:'text/plain',buffer:Buffer.from('G53 G0 X0 Y0')});
  await page.waitForFunction(()=>document.querySelector('#error').textContent.includes('Unsupported G-code'));
  if(await page.locator('.pcb-operation').count()!==3)throw Error('Invalid import lost the current job');
  await page.locator('#pcbExample').click();
  await page.waitForFunction(()=>document.querySelectorAll('.pcb-operation').length===1);
  await page.waitForFunction(()=>!document.querySelector('#pcbImport').disabled);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:path.join(artifacts,'example-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(artifacts,'example-mobile.png'),fullPage:true});
  await page.screenshot({path:path.join(artifacts,'example-mobile-viewport.png')});
  const canvasBounds=await page.locator('#pcbCanvas').boundingBox(),operationsBounds=await page.locator('#pcbOperations').boundingBox();
  if(canvasBounds.y>=operationsBounds.y)throw Error('Mobile preview follows operations instead of leading the workspace');
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile horizontal overflow');
  await page.locator('#stop').click();
  await page.locator('#recovery').waitFor({state:'visible'});
  if(await page.locator('.pcb-operation').count()!==1)throw Error('Stop discarded the job');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('PCB browser passed: import, source rejection, tool setup, stock fit, manual/captured alignment, hidden-jog lock, simulated export, package restore, synthetic rectangle preview, desktop/mobile and Stop. No hardware.');
}finally{
  if(browser)await browser.close();
  if(server.exitCode===null){const ended=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await ended;}
}
