import {observeTransport,appearance} from './workbench_browser_helpers.mjs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from '../scripts/cnc-map-ui/node_modules/esbuild/lib/main.js';
const artifacts='output/design-review/levelling';await mkdir(artifacts,{recursive:true});
// Exercise current sources without replacing shared build outputs while other workers edit them.
const assets=await mkdtemp(join(tmpdir(),'surface-results-browser-'));
const server=spawn('python3',['scripts/cnc_map_web.py','--demo','--port','0'],{stdio:['ignore','pipe','pipe']});
let browser;
try{
  const urlReady=new Promise((resolve,reject)=>{server.stdout.on('data',d=>{const m=String(d).match(/Open (http:\S+)/);if(m)resolve(m[1]);});server.once('exit',()=>reject(Error('Demo exited')));});
  const ui=await build({entryPoints:['scripts/cnc-map-ui/src/app.tsx'],bundle:true,format:'iife',target:'es2022',write:false});
  execFileSync(process.execPath,['node_modules/@tailwindcss/cli/dist/index.mjs','-i','src/styles.css','-o',join(assets,'app.css'),'--minify'],{cwd:'scripts/cnc-map-ui',stdio:'pipe'});
  const css=await readFile(join(assets,'app.css'));
  const url=await urlReady;
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960},colorScheme:'light'});
  await page.route('**/app.bundle.js',route=>route.fulfill({contentType:'text/javascript',body:ui.outputFiles[0].text}));
  await page.route('**/app.css',route=>route.fulfill({contentType:'text/css',body:css}));
  await page.addInitScript(()=>{window.resultCspViolations=[];document.addEventListener('securitypolicyviolation',event=>window.resultCspViolations.push(event.violatedDirective));});
  const writes=[],errors=[];page.on('request',r=>{if(r.method()==='POST')writes.push({url:r.url(),data:r.postDataJSON()});});page.on('pageerror',e=>errors.push(String(e)));
  await observeTransport(page);await page.goto(url);await page.locator('#surfaceTab').click();await page.waitForFunction(()=>window.testTransport.state?.demo&&window.testTransport.state.apiVersion===7);
  await page.locator('#attest').check();await page.locator('#arm').click();await page.waitForFunction(()=>window.testTransport.state.armed&&!window.testTransport.pending);
  assert.equal(await page.locator('#completeRectangle').isVisible(),false);
  await page.getByRole('button',{name:'Enter selected corner coordinates'}).click();
  for(const [corner,x,y] of [['front-left','0','0'],['back-right','60','40']]){
    await page.locator('#corner').selectOption(corner);await page.locator('#cornerX').fill(x);await page.locator('#cornerY').fill(y);await page.locator('#saveCorner').click();
    await page.waitForFunction(n=>window.testTransport.state.corners.some(p=>p.name===n)&&!window.testTransport.pending,corner);
  }
  await page.locator('#completeRectangle').waitFor({state:'visible'});
  await page.locator('#surfaceWorkspace').evaluate(node=>{node.scrollTop=0;});
  await page.locator('.surface-inspector').evaluate(node=>{node.scrollTop=0;});
  const teachingVisibility=await page.evaluate(()=>{
    const inspector=document.querySelector('.surface-inspector').getBoundingClientRect();
    const visibleBottom=document.querySelector('.statusbar').getBoundingClientRect().top;
    const visible=selector=>{
      const box=document.querySelector(selector).getBoundingClientRect();
      return box.top>=inspector.top&&box.bottom<=Math.min(inspector.bottom,visibleBottom);
    };
    const z=document.querySelector('#z').getBoundingClientRect();
    return {capture:visible('#capture'),xy:visible('[data-axis="y"][data-sign="-1"]'),zJog:visible('[data-axis="z"][data-sign="-1"]'),readouts:z.bottom<visibleBottom};
  });
  assert.deepEqual(teachingVisibility,{capture:true,xy:true,zJog:true,readouts:true},'Core teaching controls and XYZ must fit the desktop viewport');
  await page.screenshot({path:artifacts+'/teaching-desktop.png',fullPage:true});
  const pos=await page.evaluate(()=>window.testTransport.state.status.machineCoord),before=writes.length;
  await page.locator('#completeRectangle').click();await page.locator('#gridPanel').waitFor({state:'visible'});
  assert.deepEqual(await page.evaluate(()=>window.testTransport.state.status.machineCoord),pos);
  assert.equal(await page.evaluate(()=>window.testTransport.state.corners.filter(p=>p.source==='inferred').length),2);
  assert.deepEqual(writes.slice(before).map(w=>w.url.split('/').at(-1)),['complete-rectangle']);
  assert.equal(await page.locator('#spacing').inputValue(),'20'); // Valid preset for small stock.
  assert.match(await page.locator('#gridDraft').textContent(),/13 puck placements/);
  assert.equal(await page.locator('[data-draft-point]').count(),12);
  // View controls must change only the view transform, never coordinates or the API plan.
  const fittedBox=await page.locator('#plot').getAttribute('viewBox'),viewWrites=writes.length;
  await page.locator('#surfaceZoomIn').click();
  assert.notEqual(await page.locator('#plot').getAttribute('viewBox'),fittedBox);
  await page.locator('#surfaceZoomOut').click();await page.locator('#surfaceFit').click();
  assert.equal(await page.locator('#plot').getAttribute('viewBox'),fittedBox);
  assert.equal(writes.length,viewWrites,'View-only zoom issued a machine action');
  const planningWrites=writes.length;
  await page.locator('[data-grid-choice="1"]').click();assert.match(await page.locator('#gridDraft').textContent(),/36 puck placements/);
  await page.locator('[data-grid-choice="0"]').click();
  await page.locator('#surfaceContent h1').click();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');
  assert.equal(writes.length,planningWrites,'Grid navigation or keys issued a machine action');
  await page.locator('#preview').click();await page.waitForFunction(()=>window.testTransport.state.plan&&!window.testTransport.pending);
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
  await page.mouse.click(centre.x,centre.y);await page.waitForFunction(()=>!window.testTransport.state.busy&&!window.testTransport.pending&&window.testTransport.state.status.machineCoord.x>29);
  await page.locator('#toPlanning').click();assert.equal(await page.locator('#preview').isDisabled(),true);
  await page.locator('#gridReturn').waitFor({state:'visible'});
  await page.locator('#gridReturn').click();await page.waitForFunction(()=>!window.testTransport.state.busy&&!window.testTransport.pending);
  await page.waitForFunction(()=>!document.querySelector('#preview').disabled);
  assert.equal(await page.locator('#preview').isDisabled(),false);
  await page.locator('#preview').click();await page.waitForFunction(()=>window.testTransport.state.plan&&!window.testTransport.pending);
  // Editing and restoring accepted spacing must not strand the finished results as dirty.
  const acceptedSpacing=await page.locator('#spacing').inputValue();
  await page.locator('#spacing').fill(String(Number(acceptedSpacing)+1));
  assert.equal(await page.locator('#scan').isDisabled(),true);
  await page.locator('#spacing').fill(acceptedSpacing);
  assert.equal(await page.locator('#scan').isDisabled(),false);
  await page.locator('#scan').click();await page.waitForFunction(()=>window.testTransport.state.prompt?.expected==='confirm startup'&&!window.testTransport.pending);
  assert.equal(await page.locator('#promptText').isVisible(),true);
  await page.locator('#ready').click();await page.waitForFunction(()=>window.testTransport.state.prompt?.expected==='contact ready'&&!window.testTransport.pending);
  await page.locator('#ready').click();await page.waitForFunction(()=>window.testTransport.state.prompt?.expected===''&&!window.testTransport.pending);
  assert.match(await page.locator('#measureTitle').textContent(),/point 1 of 13/);
  assert.match(await page.locator('#scanRemaining').textContent(),/including setup and waiting/);
  assert.equal(await page.locator('#promptText').isVisible(),false);
  await page.locator('#probeDetails').getByRole('button',{name:'Full cycle & limits',exact:true}).click();assert.match(await page.locator('#probeContract').textContent(),/gap below 5 mm/);
  await page.locator('#probeDetails').getByRole('button',{name:'Full cycle & limits',exact:true}).click();
  await page.screenshot({path:artifacts+'/placement-desktop.png',fullPage:true});
  await appearance(page,'dark');await page.screenshot({path:artifacts+'/placement-dark.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.locator('#surfaceWorkspace').evaluate(node=>{node.scrollTop=0;});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.ok((await page.locator('#ready').boundingBox()).y<844,'Readiness hidden below map on mobile');
  await page.screenshot({path:artifacts+'/placement-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:960});
  // Every point keeps a separate readiness token; return check cannot disappear.
  const ids=new Set();
  for(let i=1;i<=13;i++){
    const prompt=await page.evaluate(()=>window.testTransport.state.prompt);assert.ok(!ids.has(prompt.id));ids.add(prompt.id);
    if(i===13){assert.match(await page.locator('#measureTitle').textContent(),/Repeat the starting point/);assert.match(await page.locator('#ready').textContent(),/check return/);}
    if(i===1){
      // Use real native keyboard activation: a held Enter must not approve a newly rendered prompt.
      await page.evaluate(()=>{
        window.testReadyRepeatEvents=[];
        window.testReadyRepeatObserver=event=>{
          if(event.target?.id==='ready'&&event.key==='Enter'&&event.repeat){
            window.testReadyRepeatEvents.push({repeat:event.repeat,prevented:event.defaultPrevented});
          }
        };
        document.addEventListener('keydown',window.testReadyRepeatObserver);
      });
      await page.locator('#ready').focus();
      try{
        await page.keyboard.down('Enter');
        await page.waitForFunction(id=>window.testTransport.state.prompt?.id!==id&&!window.testTransport.pending&&!document.querySelector('#ready').disabled,prompt.id);
        const nextPrompt=await page.evaluate(()=>window.testTransport.state.prompt);
        assert.equal(await page.evaluate(()=>window.testTransport.state.measurements.length),1,'Initial Enter must approve exactly one placement');
        const repeatWrites=writes.length;
        // Disabled/loading updates may blur a native button; target the next enabled Ready explicitly.
        await page.locator('#ready').focus();
        await page.keyboard.down('Enter');await page.keyboard.down('Enter');
        await page.waitForResponse(response=>response.url().endsWith('/api/state')&&response.ok());
        assert.deepEqual(await page.evaluate(()=>window.testReadyRepeatEvents),[{repeat:true,prevented:true},{repeat:true,prevented:true}],'Repeated native Enter was not cancelled on Ready');
        assert.equal(writes.length,repeatWrites,'Held Enter submitted another readiness action');
        assert.equal(await page.evaluate(()=>window.testTransport.state.prompt.id),nextPrompt.id,'Held Enter advanced the next placement prompt');
        assert.equal(await page.evaluate(()=>window.testTransport.state.measurements.length),1,'Held Enter measured another placement');
      }finally{
        await page.keyboard.up('Enter');
        await page.evaluate(()=>document.removeEventListener('keydown',window.testReadyRepeatObserver));
      }
    }else{
      await page.locator('#ready').click();await page.waitForFunction(id=>window.testTransport.state.prompt?.id!==id&&!window.testTransport.pending,prompt.id);
    }
  }
  assert.equal(await page.evaluate(()=>window.testTransport.state.prompt.expected),'accept observations');
  assert.equal(await page.locator('#pointGuide').isVisible(),false);
  await page.locator('#surfaceResults').waitFor({state:'visible'});
  assert.equal(await page.locator('#surfaceResultStatus').textContent(),'Awaiting acceptance');
  await page.locator('#ready').click();await page.waitForFunction(()=>window.testTransport.state.phase==='complete');
  assert.equal(await page.locator('#ugsHandoff').isVisible(),false,'Demo offered usable map');
  assert.equal(await page.evaluate(()=>window.testTransport.state.measurements.length),13);
  assert.equal(await page.locator('#surfaceResultStatus').textContent(),'Complete');
  assert.equal(await page.getByText('Apply or discard pending edits before importing the accepted map.',{exact:true}).count(),0,'Restoring accepted spacing left an inaccessible dirty draft');
  assert.ok(await page.getByText('Simulated measurements cannot be imported into UGS.',{exact:true}).count());
  assert.match(await page.locator('#surfaceResultCount').textContent(),/12 \/ 12 grid samples.*return check recorded/);
  assert.equal(await page.locator('[data-result-kind="grid"]').count(),12);
  assert.equal(await page.locator('[data-result-kind="return"]').count(),1);
  assert.match(await page.locator('#surfaceHeightRange').textContent(),/0.140/);
  assert.match(await page.locator('#surfaceReturnDrift').textContent(),/0.000/);
  assert.equal(await page.locator('#surfaceImport').isDisabled(),true,'Simulation must not offer native import');
  const inspectionWrites=writes.length;
  await page.locator('[data-result-point="1"]').click();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-result-point="2"]').getAttribute('aria-pressed'),'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('[data-result-point="13"]').getAttribute('aria-pressed'),'true');
  assert.match(await page.locator('#surfaceResults [role="status"]').textContent(),/Return check 13/);
  await page.keyboard.press('Enter');await page.keyboard.press('Space');
  const downloaded=page.waitForEvent('download');await page.locator('#downloadSurfaceReport').click();
  const download=await downloaded,report=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.match(download.suggestedFilename(),/^surface-measurements-simulated-.*\.json$/);
  assert.equal(report.simulated,true);assert.equal(report.importableAsMap,false);assert.equal(report.cuttingReleased,false);
  assert.equal(report.measurements.length,13);assert.equal(report.summary.gridSamples,12);assert.equal(report.summary.complete,true);
  const completedState=await page.evaluate(()=>window.testTransport.state);
  assert.equal(report.provenance.sessionId,completedState.sessionId);assert.deepEqual(report.measurements,completedState.measurements);
  assert.deepEqual(report.area,completedState.area);assert.deepEqual(report.plan,completedState.plan);assert.equal(report.probeMode,'puck');
  assert.ok(!JSON.stringify(report).includes(new URL(url).hash.slice(1)),'Report exposed the authentication token');
  assert.equal(writes.length,inspectionWrites,'Inspection or report download issued a machine action');
  await page.locator('#surfaceResults').scrollIntoViewIfNeeded();
  await page.screenshot({path:artifacts+'/results-dark.png',fullPage:true});
  await appearance(page,'light');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-result-point="1"]')).color===getComputedStyle(document.querySelector('#surfaceResults')).color);
  await page.screenshot({path:artifacts+'/results-light.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.locator('#surfaceResults').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Result map overflowed the document');
  await page.screenshot({path:artifacts+'/results-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:960});
  assert.equal(await page.locator('#newMap').isEnabled(),true,'A new map can explicitly retire the completed observer');
  await page.locator('#finishPreparation').click();
  await page.waitForFunction(()=>window.testTransport.state.preparationClosed&&!window.testTransport.pending);
  assert.equal(await page.locator('#surfaceResults').isVisible(),true);
  assert.match(await page.locator('#preparationClosed').textContent(),/Preparation closed.*Continue in UGS/);
  // Four inconsistent corners must stay in teaching with the correction visible.
  await page.locator('#newMap').click();await page.waitForFunction(()=>window.testTransport.state.phase==='setup'&&!window.testTransport.pending);
  await page.locator('#attest').check();await page.locator('#arm').click();await page.waitForFunction(()=>window.testTransport.state.armed&&!window.testTransport.pending);
  if(await page.locator('.manual-entry').getAttribute('data-state')!=='open')await page.getByRole('button',{name:'Enter selected corner coordinates'}).click();
  for(const [corner,x,y] of [['front-left','0','0'],['front-right','60','0'],['back-right','60','40'],['back-left','1','40']]){
    await page.locator('#corner').selectOption(corner);await page.locator('#cornerX').fill(x);await page.locator('#cornerY').fill(y);await page.locator('#saveCorner').click();
    await page.waitForFunction(n=>window.testTransport.state.corners.some(p=>p.name===n)&&!window.testTransport.pending,corner);
  }
  assert.equal(await page.locator('#geometryIssue').isVisible(),true);
  assert.equal(await page.locator('#step2').isDisabled(),true);
  assert.equal(await page.locator('#toPlanning').isDisabled(),true);
  // Native disabled controls must not switch to planning or send a request.
  const blockedWrites=writes.length;
  await page.locator('#step2').evaluate(button=>button.click());
  await page.locator('#toPlanning').evaluate(button=>button.click());
  assert.equal(writes.length,blockedWrites,'Invalid geometry issued a planning action');
  assert.equal(await page.locator('#teach').isVisible(),true);
  assert.equal(await page.locator('#gridPanel').isVisible(),false);
  await page.locator('#cornerX').fill('0');await page.locator('#saveCorner').click();await page.waitForFunction(()=>window.testTransport.state.area&&!window.testTransport.pending);
  await page.locator('#toPlanning').click();assert.equal(await page.locator('#gridPanel').isVisible(),true);
  await page.locator('#stop').click();await page.waitForFunction(()=>window.testTransport.state.phase==='stopped');
  // Browser-only fixtures: every native import is intercepted; the only server is --demo.
  let nativeState={...completedState,sessionId:'browser-native-results',demo:false,offline:false,busy:false,
    preparationClosed:false,continuityActive:true,
    measurements:completedState.measurements.map(({simulated,...record})=>record),handoff:null,
    result:{path:'/test-evidence/surface.xyz',summary:{requiredG54Z:1.234}},
  };
  let imports=0,failImport=true;
  await page.route('**/api/state',route=>route.fulfill({json:nativeState}));
  await page.route('**/api/surface-import',route=>{
    imports++;
    if(failImport)return route.fulfill({status:400,json:{error:'Test fixture rejects native import'}});
    nativeState={...nativeState,handoff:{verified:true,sha256:'a'.repeat(64),compensationApplied:false,continuityVerified:false,materialZVerified:false}};
    return route.fulfill({json:{result:nativeState.handoff}});
  });
  let finishes=0;
  await page.route('**/api/handoff-finish',route=>{
    finishes++;
    nativeState={...nativeState,preparationClosed:true,continuityActive:false,canStartFresh:true};
    return route.fulfill({json:{result:{preparationClosed:true}}});
  });
  await page.waitForFunction(()=>window.testTransport.state?.sessionId==='browser-native-results');
  await page.locator('#surfaceImport').waitFor({state:'visible'});
  assert.equal(imports,0,'Results automatically imported the map');
  assert.match(await page.locator('#surfaceImportReceipt').textContent(),/No verified/);
  assert.equal(await page.locator('#surfaceMapPath').isVisible(),false);
  await page.locator('#surfaceImport').click();
  await page.waitForFunction(()=>!window.testTransport.pending);
  assert.equal(imports,1);assert.match(await page.locator('#surfaceImportReceipt').textContent(),/No verified/,'Rejected import fabricated a receipt');
  failImport=false;
  await page.locator('#surfaceImport').click();
  await page.waitForFunction(()=>window.testTransport.state?.handoff?.verified&&!window.testTransport.pending);
  assert.equal(imports,2);assert.match(await page.locator('#surfaceImportReceipt').textContent(),/verified by server readback/);
  await page.getByRole('button',{name:'Map file, datum & cutting checks'}).click();
  assert.match(await page.locator('#surfaceMapPath').textContent(),/test-evidence/);assert.match(await page.locator('#handoffDatum').textContent(),/1.234/);
  assert.equal(await page.locator('#newMap').isEnabled(),true);assert.equal(finishes,0);
  await page.locator('#finishPreparation').click();
  await page.waitForFunction(()=>window.testTransport.state?.preparationClosed&&!window.testTransport.pending);
  assert.equal(finishes,1);assert.equal(await page.locator('#surfaceImport').isDisabled(),true);
  assert.equal(await page.locator('#finishPreparation').count(),0);assert.equal(await page.locator('#newMap').isDisabled(),false);
  assert.equal(await page.locator('#surfaceResults').isVisible(),true);
  assert.match(await page.locator('#surfaceImportReceipt').textContent(),/physical reference continuity remain unverified/);
  nativeState={...nativeState,phase:'stopped',handoff:null,result:null,measurements:nativeState.measurements.slice(0,2)};
  await page.waitForFunction(()=>window.testTransport.state?.phase==='stopped');
  assert.equal(await page.locator('#surfaceResultStatus').textContent(),'Incomplete');
  assert.match(await page.locator('#surfaceResultCount').textContent(),/2 \/ 12 grid samples.*not recorded/);
  assert.equal(await page.locator('[data-result-kind="return"]').count(),0);
  nativeState={...nativeState,sessionId:'browser-offline-results',phase:'setup',offline:true,measurements:[]};
  await page.locator('#surfaceOffline').waitFor({state:'visible'});
  assert.equal(await page.locator('#arm').isDisabled(),true);
  await page.locator('#arm').evaluate(button=>button.click());
  await page.locator('#surfaceOfflineJob').click();
  assert.equal(await page.locator('#surfaceContent').isVisible(),false);
  assert.equal(imports,2);
  assert.deepEqual(await page.evaluate(()=>window.resultCspViolations),[],'Results violated the page CSP');
  assert.deepEqual(errors,[]);
  console.log('Efficient mapping passed: guarded movement/readiness, complete and partial results, numbered inspection without movement, evidence JSON, explicit native import/receipt fixtures, offline lock, desktop/dark/mobile. Demo and intercepted fixtures only.');
}finally{if(browser)await browser.close();if(server.exitCode===null){const stopped=new Promise(r=>server.once('exit',r));server.kill('SIGTERM');await stopped;}await rm(assets,{recursive:true,force:true});}
