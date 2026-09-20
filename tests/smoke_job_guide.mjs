import {observeTransport,appearance,openUtility,closeUtility} from './workbench_browser_helpers.mjs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
const artifacts='output/design-review/job-guide';await mkdir(artifacts,{recursive:true});
const server=spawn('python3',['scripts/cnc_map_web.py','--demo','--port','0'],{stdio:['ignore','pipe','pipe']});
let browser;
try{
 const url=await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{const m=String(d).match(/Open (http:\S+)/);if(m)resolve(m[1]);});server.once('exit',()=>reject(Error('Demo exited')));});
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:960},colorScheme:'light',reducedMotion:'reduce'});
 const errors=[],writes=[];page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.method()==='POST')writes.push(r.url().split('/').at(-1));});
 await observeTransport(page);await page.goto(url);const guide=page.locator('#guideWorkspace');const tools=page.locator('#toolsWorkspace');
 await guide.getByRole('heading',{name:'What are you making?'}).waitFor();
 assert.equal(await page.locator('#guideTab').getAttribute('data-active'),'true');
 await page.screenshot({path:artifacts+'/empty-light.png',fullPage:true});
 await guide.getByRole('button',{name:'Explore a geometry example'}).click();
 await guide.getByRole('heading',{name:'Rectangle example'}).waitFor();
 await guide.getByRole('img',{name:/Stock, cutting paths/}).waitFor();
 await guide.getByRole('button',{name:'Material & process',exact:true}).click();
 // Both package entry points must respect displayed process drafts.
 await guide.getByRole('combobox',{name:'Material',exact:true}).selectOption('wood');
 assert.equal(await guide.getByRole('button',{name:'Save job',exact:true}).isDisabled(),true);
 assert.equal(await guide.getByRole('button',{name:'Save process settings',exact:true}).isEnabled(),true);
 await page.locator('#pcbTab').click();
 assert.equal(await page.locator('#pcbSave').isDisabled(),true);
 await page.locator('#pcbNew').click();await page.getByRole('button',{name:'Replace job',exact:true}).click();await page.waitForFunction(()=>window.testTransport.job?.operations.length===0&&!window.testTransport.pending);
 await page.locator('#guideTab').click();
 assert.equal(await page.evaluate(()=>window.testTransport.job.workflow.material),'pcb','New job retained the old material draft');
 await guide.getByRole('button',{name:'Explore a geometry example'}).click();await guide.getByRole('heading',{name:'Rectangle example'}).waitFor();
 await guide.getByRole('combobox',{name:'Material',exact:true}).selectOption('wood');
 await guide.getByRole('button',{name:'Save process settings'}).click();
 await page.waitForFunction(()=>window.testTransport.job.workflow.material==='wood'&&!window.testTransport.pending);
 await page.locator('#toolsTab').click();
 // Form and disclosure keys never become machine commands.
 const before=writes.length;
 await tools.getByRole('tab',{name:'Recipes',exact:true}).click();
 await tools.getByRole('button',{name:'Estimate a V-bit cutting width',exact:true}).click();
 for(const [label,value] of [['Flat tip diameter (mm)','0.1'],['Included angle (degrees)','30'],['Depth (mm)','0.1'],['Cutting-head diameter (mm)','3']])await tools.getByRole('spinbutton',{name:label,exact:true}).fill(value);
 await tools.getByRole('button',{name:'Estimate cutting width',exact:true}).click();
 await tools.getByText(/Estimated width 0\.153[0-9]+ mm/).waitFor();
 assert.deepEqual(writes.slice(before),['pcb-vbit']);
 await tools.getByRole('tab',{name:'Tool changes',exact:true}).click();
 await tools.getByRole('textbox',{name:'Observed setup, measurement or unresolved issue'}).fill('Changed cutter. Z has not been re-probed.');
 await tools.getByRole('button',{name:'Save observation'}).click();
 await tools.getByText('Observation only',{exact:true}).waitFor();
 await tools.getByRole('button',{name:'Visualise a board flip'}).click();
 await tools.getByRole('spinbutton',{name:'Reference X (mm)',exact:true}).fill('20');
 await tools.getByRole('spinbutton',{name:'Reference Y (mm)',exact:true}).fill('15');
 await tools.getByText('After flip: X 20 · Y 55').waitFor();
 // Numeric camera calibration, with held-out C, sends no camera or motion requests.
 await tools.getByRole('tab',{name:'Camera',exact:true}).click();
 await tools.getByRole('spinbutton',{name:'Common captured Z (mm)'}).fill('5');
 await tools.getByRole('spinbutton',{name:'Maximum residual (mm)'}).fill('0.05');
 for(const [label,sx,sy,cx,cy] of [['A',10,10,8,7],['B',30,10,28,7],['C',10,30,8,27]]){
  for(const [part,value] of [['spindle-centred machine X',sx],['spindle-centred machine Y',sy],['camera-centred machine X',cx],['camera-centred machine Y',cy]])await tools.getByRole('spinbutton',{name:`Point ${label} ${part} (mm)`}).fill(String(value));
 }
 await tools.getByRole('checkbox',{name:/All six captures/}).check();await tools.getByRole('button',{name:'Check camera offset'}).click();
 await tools.getByText('Numerically checked offset',{exact:true}).waitFor();
 await tools.getByText('X 2 · Y 3 mm',{exact:true}).waitFor();
 assert.equal(writes.some(x=>['jog','jog-hold','goto','scan','surface-import'].includes(x)),false);
 assert.equal(await guide.getByRole('button',{name:'Import accepted map',includeHidden:true}).isDisabled(),true);
 await tools.getByRole('tab',{name:'Fixtures',exact:true}).click();

 // Modelled fixtures feed the draft generator through the real endpoint.
 for(const [label,value] of [['Minimum machine X (mm)',-10],['Maximum machine X (mm)',60],['Minimum machine Y (mm)',-10],['Maximum machine Y (mm)',60],['Minimum tip Z from material (mm)',-2],['Maximum tip Z from material (mm)',30],['Additional clearance margin (mm)',0]])await tools.getByRole('spinbutton',{name:label,exact:true}).fill(String(value));
 await tools.getByRole('button',{name:'Save fixture',exact:true}).click();await page.waitForFunction(()=>window.testTransport.job.workflow.fixture&&!window.testTransport.pending);
 await tools.getByRole('tab',{name:'Wood',exact:true}).click();
 for(const [label,value] of [['G54 origin, machine X (mm)',0],['G54 origin, machine Y (mm)',0],['Minimum G54 X (mm)',0],['Maximum G54 X (mm)',20],['Minimum G54 Y (mm)',0],['Maximum G54 Y (mm)',15],['Maximum tool / shaft diameter (mm)',2],['Holder diameter (mm)',8],['Exposed tip-to-holder length (mm)',10],['Usable cutting length (mm)',4],['Cutting feed (mm/min)',50],['Plunge feed (mm/min)',5],['Total depth below Z0 (mm)',.2],['Depth per pass (mm)',.1],['Clear Z above the material (mm)',6],['Spindle S command',500]])await tools.getByRole('spinbutton',{name:label,exact:true}).fill(String(value));
 await tools.getByRole('combobox',{name:'Draft type'}).selectOption('surfacing');
 await tools.getByRole('spinbutton',{name:'Raster stepover (mm)'}).fill('1');
 await tools.getByRole('button',{name:'Review the configuration for this draft',exact:true}).click();
 for(const label of ['Machine limits and coordinate directions reviewed','Tool dimensions, plunge capability and intended cut reviewed','Material, depth and cutting parameters reviewed','Workholding, clamps and clearance reviewed','G54 origin and material Z0 reviewed for this draft','Clockwise spindle operation and S command scale reviewed'])await tools.getByRole('checkbox',{name:label,exact:true}).check();
 await tools.getByRole('button',{name:'Prepare surfacing draft',exact:true}).click();
 await tools.getByRole('link',{name:/Download .*DEMO\.nc\.txt/}).waitFor();
 await tools.getByRole('button',{name:'Inspect generated G-code'}).click();
 assert.match(await tools.getByLabel('Generated draft G-code').textContent(),/SIMULATED/);
 await tools.getByRole('spinbutton',{name:'Total depth below Z0 (mm)'}).fill('0.3');
 assert.equal(await tools.getByRole('button',{name:'Prepare surfacing draft',exact:true}).isDisabled(),true);
 assert.equal(await tools.getByRole('link',{name:/Download .*DEMO\.nc\.txt/}).count(),0,'Changed inputs must hide stale output');
 await tools.getByRole('tab',{name:'Fixtures',exact:true}).click();
 await page.locator('#guideTab').click();
 // Screenshots inspect both themes and a compact portrait, with no horizontal overflow.
 await page.evaluate(()=>document.querySelector('#guideWorkspace').scrollTop=0);
 await page.screenshot({path:artifacts+'/job-light.png',fullPage:true});
 await appearance(page,'dark');
 await page.screenshot({path:artifacts+'/job-dark.png',fullPage:true});
 await page.setViewportSize({width:1024,height:768});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await page.screenshot({path:artifacts+'/compact-dark.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
 await appearance(page,'light');
 await page.screenshot({path:artifacts+'/mobile-light.png',fullPage:true});
 // Automated copper route has one approval and remains cancellable; simulation only.
 await page.setViewportSize({width:1440,height:960});await page.locator('#surfaceTab').click();
 await page.getByRole('radio',{name:/Continuous copper/}).click();await page.waitForFunction(()=>window.testTransport.state.probeMode==='copper'&&!window.testTransport.pending);
 await page.locator('#attest').check();await page.locator('#arm').click();await page.waitForFunction(()=>window.testTransport.state.armed&&!window.testTransport.pending);
 await page.getByRole('button',{name:'Enter selected corner coordinates'}).click();
 for(const [corner,x,y] of [['front-left','0','0'],['back-right','10','10']]){
  await page.locator('#corner').selectOption(corner);await page.locator('#cornerX').fill(x);await page.locator('#cornerY').fill(y);await page.locator('#saveCorner').click();await page.waitForFunction(n=>window.testTransport.state.corners.some(p=>p.name===n)&&!window.testTransport.pending,corner);
 }
 await page.locator('#completeRectangle').click();await page.locator('#gridPanel').waitFor();await page.locator('#spacing').fill('5');await page.locator('#preview').click();await page.waitForFunction(()=>window.testTransport.state.plan&&!window.testTransport.pending);
 assert.equal(await page.evaluate(()=>window.testTransport.state.plan.puckHeight),0);
 await page.locator('#scan').click();
 for(const expected of ['confirm startup','contact ready']){
  await page.waitForFunction(x=>window.testTransport.state.prompt?.expected===x&&!window.testTransport.pending,expected);await page.locator('#ready').click();
 }
 await page.waitForFunction(()=>window.testTransport.state.prompt?.expected==='start copper scan'&&!window.testTransport.pending);
 const start=writes.length;await page.locator('#ready').click();await page.waitForFunction(()=>window.testTransport.state.prompt?.expected==='accept observations'&&!window.testTransport.pending);
 assert.equal(writes.slice(start).filter(x=>x==='reply').length,1,'Copper should not require per-point Ready');
 assert.equal(await page.evaluate(()=>window.testTransport.state.measurements.length),10);
 await page.locator('#ready').click();await page.waitForFunction(()=>window.testTransport.state.phase==='complete');
 await page.locator('#guideTab').click();assert.equal(await guide.getByRole('button',{name:'Import accepted map',includeHidden:true}).isDisabled(),true);
 assert.deepEqual(errors,[]);console.log('Job guide: AI Elements, process linkage, offline tools, themes, layouts and automatic copper flow passed.');
}finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
