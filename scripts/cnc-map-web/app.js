const $=id=>document.getElementById(id);
const token=location.hash.slice(1)||sessionStorage.getItem('surface-token')||'';
if(token)sessionStorage.setItem('surface-token',token);
history.replaceState(null,'',location.pathname);
const client=sessionStorage.getItem('surface-client')||crypto.randomUUID();
sessionStorage.setItem('surface-client',client);
const names=['front-left','front-right','back-right','back-left'];
const opposites={'front-left':'back-right','front-right':'back-left','back-right':'front-left','back-left':'front-right'};
const headers={'Authorization':'Bearer '+token,'X-Client-ID':client,'Content-Type':'application/json'};
let state=null,sending=false,online=false,pollTask=null,lastPrompt=null,activeHold=null,plotTransform=null,errorKind=null;
let pcbPanel=null,mappingView='teach';
const number=n=>Number.isFinite(n)?n.toFixed(3):'—';
const title=name=>name.replace('-',' ');
function error(message,kind='action'){errorKind=message?kind:null;$('error').hidden=!message;$('error').textContent=message||'';}
async function call(action,body={},receive=null){
  if(sending&&action!=='stop')return false;
  const ownsPending=action!=='stop';
  if(ownsPending)sending=true;
  render();
  let ok=false;
  try{
    const r=await fetch('/api/'+action,{method:'POST',headers,body:JSON.stringify({...body,sessionId:state?.sessionId}),signal:AbortSignal.timeout(25000)});
    const d=await r.json();if(!r.ok)throw Error(d.error);
    error('');if(receive)receive(d.result);ok=true;
  }catch(e){if(action==='jog-hold')releaseHold();error(e.message);}
  finally{
    await poll(true);
    if(ownsPending)sending=false;
    render();
  }
  return ok;
}
async function poll(fresh=false){
  if(pollTask){await pollTask;if(!fresh)return;}
  if(document.hidden)return;
  pollTask=(async()=>{
    try{
      const r=await fetch('/api/state',{headers,signal:AbortSignal.timeout(2000)});
      const d=await r.json();if(!r.ok)throw Error(d.error);
      if(d.apiVersion!==6)throw Error('The server needs the current app version. Restart it with ./cnc-map restart and reopen its link');
      if(errorKind==='connection')error('');
      if(state&&state.sessionId!==d.sessionId){
        releaseHold();$('attest').checked=false;$('clickMove').checked=false;lastPrompt=null;mappingView='teach';
      }
      state=d;online=true;
    }catch(e){
      online=false;releaseHold();error('Connection unavailable: '+e.message+'. Controls are locked.','connection');
    }
    render();
  })();
  try{await pollTask;}finally{pollTask=null;}
}
function draftGrid(){
  return window.SurfaceGuide.previewGrid(state?.area,Number($('spacing').value),state?.status?.machineCoord);
}
function planIsCurrent(){return !!state?.plan&&Number($('spacing').value)===state.plan.grid.spacing;}
function render(){
  const s=state;
  window.SurfaceUI?.update(s,online,sending);
  if(s?.configuration){
    const c=s.configuration;
    $('machineName').textContent=c.name;
    $('configSummary').textContent=(s.demo?'Simulation: ':'Machine: ')+c.name;
    $('configValues').replaceChildren();
    for(const [label,value] of Object.entries({'UGS address':'127.0.0.1:'+c.ugsPort,'Puck height':c.puckHeight+' mm','XY travel':c.feeds.xy+' mm/min','Z travel':c.feeds.z+' mm/min','First contact':c.feeds.first+' mm/min','Second contact':c.feeds.second+' mm/min'})){
      const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;$('configValues').append(dt,dd);
    }
  }
  $('arm').disabled=!online||sending||!$('attest').checked||s?.phase!=='setup';
  $('checkConnection').disabled=!online||sending||!!s?.busy;
  $('report').disabled=!online;
  pcbPanel?.update(s,{online,sending});
  if(!s)return;
  const n=s.corners.length,baseLocked=!online||sending||s.busy||!s.armed||s.phase!=='teach';
  if(n<4||!s.area||s.geometryIssue)mappingView='teach';
  const locked=baseLocked||mappingView!=='teach';
  const currentPlan=planIsCurrent();
  $('mode').textContent=s.demo?'DEMO · NO MACHINE ACCESS':'LOCAL · UGS API';
  $('connection').textContent=!online?'Connection lost':s.phase==='stopped'?'● Session stopped':s.demo?'● Demo connected':s.status?'● UGS '+s.status.state.toLowerCase():'● Local UI · not armed';
  $('setup').hidden=s.phase!=='setup';$('teach').hidden=s.phase!=='teach'||mappingView!=='teach';
  $('gridPanel').hidden=s.phase!=='teach'||mappingView!=='grid';
  $('mapMoveControls').hidden=s.phase!=='teach'||mappingView!=='teach';
  $('surfaceWorkspace').dataset.phase=s.phase==='teach'?mappingView:s.phase;
  $('measurement').hidden=s.phase!=='scan';$('finished').hidden=s.phase!=='complete';
  $('recovery').hidden=s.phase!=='stopped';
  $('operation').textContent=s.phase==='stopped'?'Stopped · review setup':(s.busy||sending)?(s.prompt?'Waiting for you':'Operation in progress'):s.phase;
  if(s.fault){
    $('recoveryTitle').textContent=s.fault.title;
    $('recoveryHelp').textContent=s.fault.nextStep;
    $('recoveryDetail').textContent=s.fault.detail;
  }
  $('fresh').disabled=$('newMap').disabled=!online||sending||!s.canStartFresh;
  $('fresh').textContent=s.canStartFresh?'Start fresh setup':'Waiting for workers to stop…';
  for(const axis of ['x','y','z'])$(axis).textContent=number(s.status?.machineCoord?.[axis]);
  const selected=$('corner').value,recorded=s.corners.some(p=>p.name===selected);
  $('cornerNumber').textContent=n+' OF 4 CORNERS RECORDED · ANY ORDER';
  $('rectangleShortcut').hidden=!s.area||n===4;
  $('areaReady').hidden=n!==4||!s.area||!!s.geometryIssue;
  $('completeRectangle').disabled=locked||!!activeHold;
  $('toPlanning').disabled=baseLocked||!!activeHold||n!==4||!s.area||!!s.geometryIssue;
  if(s.area){
    $('rectangleText').textContent=number(s.area.x[1]-s.area.x[0])+' × '+number(s.area.y[1]-s.area.y[0])+' mm. '+(4-n)+' corner'+(4-n===1?'':'s')+' can be inferred from the points you recorded.';
    $('completeRectangle').textContent='Accept '+(4-n)+' remaining corner'+(4-n===1?'':'s')+' & plan grid';
  }
  $('cornerTitle').textContent=title(selected);
  $('jogHint').textContent=n===0?'Choose whichever corner is closest. Set a raised Z that clears the puck and clamps throughout the area.':
    n===1?'Teach the opposite corner next to unlock exact positioning for the remaining corners. Keep the same raised Z.':
    'Record corners in any order. Match left/right X and front/back Y to form a rectangle; keep the raised Z.';
  $('geometryIssue').hidden=!s.geometryIssue;$('geometryIssue').textContent=s.geometryIssue||'';
  $('corner').disabled=locked||!!activeHold;
  for(const option of $('corner').options)option.textContent=title(option.value)+(s.corners.some(p=>p.name===option.value)?' ✓':'');
  $('gotoCorner').disabled=locked||!!activeHold||!s.area;
  $('clickMove').disabled=locked||!!activeHold||!s.area;
  $('mapHint').textContent=s.area?(n<4?'Outline known. Click a dashed corner to accept it, or move there and record its position.':'Click inside the rectangle to move at the taught raised Z.'):'Record two opposite corners to define the positioning area.';
  $('plot').classList.toggle('clickable',!$('clickMove').disabled&&$('clickMove').checked);
  const allowed=n===0?'xyz':'xy';
  document.querySelectorAll('[data-axis]').forEach(b=>{
    const held=activeHold?.axis===b.dataset.axis&&activeHold?.sign===Number(b.dataset.sign);
    b.disabled=!held&&(locked||!allowed.includes(b.dataset.axis));b.classList.toggle('held',held);
  });
  for(const id of ['speed','jogMode','distance'])$(id).disabled=locked||!!activeHold;
  $('fastHold').disabled=locked||!!activeHold||$('jogMode').value!=='hold';
  $('jogMode').querySelector('[value="hold"]').disabled=!s.nativeJog;
  if(!s.nativeJog&&$('jogMode').value==='hold')$('jogMode').value='step';
  if($('jogMode').value==='hold')$('distance').disabled=true;
  const rates=s.speeds?.[$('speed').value];
  const holdRates=s.speeds?.[activeHold?.speed||($('fastHold').checked?'maximum':$('speed').value)];
  $('speedHint').textContent=(rates?'Selected X '+rates.x+' · Y '+rates.y+' · Z '+rates.z+' mm/min. ':'')+
    (holdRates&&$('jogMode').value==='hold'?'XY hold X '+holdRates.x+' · Y '+holdRates.y+' mm/min. ':'')+
    (!s.nativeJog?'Smooth Hold needs the UGS extension.':'Maximum follows controller settings; allow room to decelerate.');
  if(activeHold&&s.phase!=='teach')releaseHold();
  $('capture').disabled=locked||!!activeHold;
  $('saveCorner').disabled=locked||!!activeHold;
  $('capture').textContent=(recorded?'Update':'Record')+' '+selected+' corner ↵';
  $('reset').disabled=locked;
  $('spacing').disabled=baseLocked;
  const draft=draftGrid();
  $('preview').disabled=baseLocked||!s.area||!!draft?.error||!draft?.startsHere;
  $('scan').disabled=baseLocked||!currentPlan;
  $('preview').hidden=currentPlan;
  $('scan').hidden=!s.plan;
  $('planSummary').hidden=!s.plan;
  $('gridDraft').textContent=draft?.error||(draft?draft.grid.x.length+' × '+draft.grid.y.length+' grid · '+draft.placements+' puck placements, including return check.':'');
  $('gridDraft').classList.toggle('invalid',!!draft?.error);
  $('gridArea').textContent=s.area?number(s.area.x[1]-s.area.x[0])+' × '+number(s.area.y[1]-s.area.y[0])+' mm usable area. Map only the area the job needs.':'';
  const choices=window.SurfaceGuide.gridChoices(s.area);
  document.querySelectorAll('[data-grid-choice]').forEach((b,i)=>{
    const option=choices[i];b.disabled=baseLocked||!option||!!option.draft?.error;
    b.setAttribute('aria-pressed',String(option?.spacing===Number($('spacing').value)));
    b.querySelector('span').textContent=option&&!option.draft?.error?option.draft.placements+' placements · '+option.spacing+' mm':'Unavailable';
  });
  $('gridStartHelp').textContent=draft?.error?'':draft?.startsHere?'The cutter is at a grid point. Measurement will start here.':'The cutter is between grid points. Move to a corner before previewing the route.';
  $('gridReturn').hidden=!draft||!!draft.error||draft.startsHere;
  $('gridReturn').disabled=baseLocked||!!activeHold;
  const currentPosition=s.status?.machineCoord;
  const nearest=currentPosition?[...s.corners].sort((a,b)=>Math.hypot(a.x-currentPosition.x,a.y-currentPosition.y)-Math.hypot(b.x-currentPosition.x,b.y-currentPosition.y))[0]:null;
  if(nearest)$('gridReturn').textContent='Move to '+title(nearest.name)+' · X '+number(nearest.x)+' Y '+number(nearest.y);
  $('count').textContent=draft&&!draft.error?draft.points:'—';
  if(s.plan){
    const g=s.plan.grid,total=g.x.length*g.y.length;
    const seconds=((s.route?.distance||0)/(s.plan.feeds.xy)*60).toFixed(1);
    $('planText').textContent=!currentPlan?'Spacing changed. Preview the updated grid before scanning.':
      g.x.length+' × '+g.y.length+' grid · '+(total+1)+' puck placements including return. '+Math.round(s.route?.distance||0)+' mm XY travel (about '+seconds+' s at commanded feed). Traverse at machine Z '+number(s.plan.travelZ)+' mm; probe '+s.plan.feeds.first+' then '+s.plan.feeds.second+' mm/min.';
  }
  const p=s.prompt;$('ready').disabled=!online||sending||!p;
  const point=s.currentPoint,placement=p?.expected===''&&!!point,returning=point?.index===point?.total;
  $('measureTitle').textContent=placement?(returning?'Repeat the starting point':'Place puck · point '+point.index+' of '+point.total):p?.expected==='accept observations'?'Review your observations':p?.expected==='contact ready'?'Check probe contact':p?'Check the setup':'Measuring & moving…';
  $('pointGuide').hidden=!point||p?.expected==='accept observations';
  if(point){
    $('pointLocation').textContent='X '+number(point.point.x)+'   Y '+number(point.point.y)+' mm';
    $('pointInstruction').textContent=placement?(returning?'Place the puck where the scan began. This final repeat checks whether the reference drifted.':'Seat the puck flat under the cutter. Tip centred, gap below '+(s.plan?.probe?.firstSearch||5)+' mm. Clear your hands, then press Ready or Enter.'):'Keep hands clear. Wait for the next placement prompt before moving the puck.';
    const next=s.route?.points[point.index];
    $('nextPoint').textContent=next?'Next: X '+number(next.x)+' · Y '+number(next.y)+' mm'+(point.index===point.total-1?' · return check':'')+'. Travel follows the measurement automatically.':'Final measurement · no further XY travel.';
  }
  $('promptText').hidden=placement;
  $('promptText').textContent=p?.prompt||'Keep hands clear and leave the puck stationary until the next placement prompt.';
  $('probeDetails').hidden=!placement;$('probeContract').textContent=placement?p.prompt:'';
  $('ready').textContent=placement?(returning?'Ready — check return ↵':'Ready — measure & advance ↵'):p?.expected==='contact ready'?'Contact checked — continue':p?.expected==='accept observations'?'Accept observations & save':'Confirm displayed checks';
  lastPrompt=p;
  const measured=s.measurements.length,total=s.route?.points.length||1,last=s.measurements.at(-1);
  $('scanProgress').max=total;$('scanProgress').value=measured;
  $('scanProgressText').textContent=(s.demo?'SIMULATED · ':'')+measured+' / '+total+' measurements'+(last?' · last repeat spread '+number(last.spread)+' mm':'')+'.';
  $('scanRemaining').textContent=Math.max(0,total-measured)+' measurements remaining · '+window.SurfaceGuide.formatDuration(s.scanStarted?Date.now()/1000-s.scanStarted:0)+' elapsed, including setup and waiting.';
  $('step1').disabled=s.phase!=='teach'||sending||s.busy||!!activeHold;
  $('step2').disabled=baseLocked||n!==4||!s.area||!!s.geometryIssue||!!activeHold;
  $('backToArea').disabled=baseLocked||!!activeHold;
  $('step1').classList.toggle('active',s.phase==='setup'||(s.phase==='teach'&&mappingView==='teach'));
  $('step2').classList.toggle('active',s.phase==='teach'&&mappingView==='grid');
  $('step1').setAttribute('aria-current',mappingView==='teach'&&s.phase==='teach'?'step':'false');
  $('step2').setAttribute('aria-current',mappingView==='grid'&&s.phase==='teach'?'step':'false');
  $('step3').classList.toggle('active',['scan','complete'].includes(s.phase));
  $('areaCaption').textContent=s.phase==='scan'?'Measured points and next placement':currentPlan?'Scan route · dashed return check':mappingView==='grid'?'Draft grid · preview the route before measurement':n+' of 4 inset corners recorded';
  $('log').textContent=s.logs.join('\n');
  $('finishedTitle').textContent=s.demo?'Demo complete.':'Measurements saved.';
  $('ugsHandoff').hidden=!s.result||s.demo;
  if(s.result){
    $('finishedText').textContent='Saved, not yet imported or applied in UGS. Return drift: '+number(s.result.summary.drift)+' mm. Offsets were preserved.\n'+s.result.path;
    $('handoffDatum').textContent='Required material-top G54 Z: '+number(s.result.summary.requiredG54Z)+' mm. Verify this reference before cutting; the app has not changed it.';
  }
  if(s.demo)$('finishedText').textContent='The full workflow completed with simulated readings. No machine commands or map files were created. Start another demo setup here, or restart without --demo for UGS.';
  renderCorners();renderHealth();draw();
}
function renderCorners(){
  $('cornerTable').replaceChildren();
  for(const name of names){
    const point=state.corners.find(p=>p.name===name),row=document.createElement('div'),label=document.createElement('span'),value=document.createElement('span');
    label.textContent=title(name);value.textContent=point?'X '+number(point.x)+' · Y '+number(point.y)+' · '+(point.source||'captured'):'Not recorded';
    row.append(label,value);$('cornerTable').append(row);
  }
}
function renderHealth(){
  const host=$('health');host.replaceChildren();
  if(!state.diagnostics)return;
  for(const check of state.diagnostics.checks){
    const row=document.createElement('div'),label=document.createElement('strong'),detail=document.createElement('span');
    row.className='health-row '+(check.ok===true?'passed':check.ok===false?'failed':'note');
    label.textContent=(check.ok===true?'✓ ':check.ok===false?'! ':'· ')+check.label;
    detail.textContent=check.detail;row.append(label,detail);host.append(row);
  }
  const time=document.createElement('p');time.className='micro';time.textContent='Checked '+state.diagnostics.checkedAt;host.append(time);
}
function draw(){
  const focusedSuggestion=document.activeElement?.getAttribute('data-suggested');
  const svg=$('plot'),ns='http://www.w3.org/2000/svg';svg.replaceChildren();plotTransform=null;
  const screenScale=Math.abs(svg.getScreenCTM()?.a||1),pixels=n=>n/screenScale;
  function add(tag,attrs,text){
    if(attrs['font-size'])attrs['font-size']=pixels(Math.max(11,Number(attrs['font-size'])));
    const e=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));
    if(text)e.textContent=text;svg.append(e);return e;
  }
  for(let x=30;x<640;x+=25)for(let y=20;y<410;y+=25)add('circle',{cx:x,cy:y,r:1,fill:'var(--grid)'});
  const ps=state.corners,plan=planIsCurrent()?state.plan:null;
  const draft=mappingView==='grid'&&!plan?draftGrid():null;
  if(!ps.length){
    add('rect',{x:115,y:65,width:410,height:260,rx:4,fill:'var(--stock)',stroke:'var(--stock-line)','stroke-dasharray':'5 6'});
    add('text',{x:320,y:190,'text-anchor':'middle',fill:'var(--muted)','font-size':13},'Your taught area will appear here');
    add('text',{x:320,y:213,'text-anchor':'middle',fill:'var(--muted)','font-size':11},'Start at whichever corner is closest');return;
  }
  const xs=ps.map(p=>p.x),ys=ps.map(p=>p.y),xmin=Math.min(...xs),ymin=Math.min(...ys),w=Math.max(...xs)-xmin||20,h=Math.max(...ys)-ymin||20;
  const scale=Math.min(470/w,270/h),ox=320-w*scale/2,oy=205+h*scale/2;
  plotTransform={scale,ox,oy,xmin,ymin};
  const xy=p=>[ox+(p.x-xmin)*scale,oy-(p.y-ymin)*scale];
  if(state.area){
    const a=state.area;
    add('polygon',{points:[{x:a.x[0],y:a.y[0]},{x:a.x[1],y:a.y[0]},{x:a.x[1],y:a.y[1]},{x:a.x[0],y:a.y[1]}].map(p=>xy(p).join(',')).join(' '),fill:'var(--stock)',stroke:'var(--stock-line)','stroke-width':1.5});
  }
  if(plan&&state.route){
    const points=state.route.points,solid=points.slice(0,-1).map(p=>xy(p).join(',')).join(' ');
    add('polyline',{points:solid,fill:'none',stroke:'var(--accent)','stroke-width':1.5,'data-route':'scan'});
    add('polyline',{points:points.slice(-2).map(p=>xy(p).join(',')).join(' '),fill:'none',stroke:'var(--warning)','stroke-width':2,'stroke-dasharray':'5 5','data-route':'return'});
    for(const x of plan.grid.x)for(const y of plan.grid.y){const [cx,cy]=xy({x,y});add('circle',{cx,cy,r:3.5,fill:'var(--accent)'});}
    const [x,y]=xy(points[0]),right=points[0].x>xmin+w/2,back=points[0].y>ymin+h/2;
    add('text',{x:x+pixels(right?-18:18),y:y+pixels(back?30:-25),'text-anchor':right?'end':'start','font-size':11,fill:'var(--accent)'},'Start / return');
  }
  if(draft&&!draft.error)for(const x of draft.grid.x)for(const y of draft.grid.y){
    const [cx,cy]=xy({x,y});add('circle',{cx,cy,r:pixels(3),fill:'var(--muted)',opacity:.7,'data-draft-point':'true'});
  }
  for(const p of state.measurements){const [cx,cy]=xy(p);add('circle',{cx,cy,r:6,fill:'var(--accent)',stroke:'var(--surface)','stroke-width':1.5});}
  if(state.currentPoint){
    const [cx,cy]=xy(state.currentPoint.point);add('circle',{cx,cy,r:pixels(17),fill:'none',stroke:'var(--warning)','stroke-width':2});
    const next=state.route?.points[state.currentPoint.index];
    if(next){const [nx,ny]=xy(next);add('circle',{cx:nx,cy:ny,r:pixels(10),fill:'none',stroke:'var(--muted)','stroke-dasharray':'3 3','stroke-width':1.5});add('text',{x:nx,y:ny-pixels(18),'font-size':11,fill:'var(--muted)','text-anchor':'middle'},'Next');}
  }
  if(state.area&&!plan)for(const name of names.filter(n=>!ps.some(p=>p.name===n))){
    const [fb,lr]=name.split('-'),p={x:state.area.x[lr==='left'?0:1],y:state.area.y[fb==='front'?0:1]};
    const [cx,cy]=xy(p);
    const marker=add('circle',{cx,cy,r:Math.max(15,pixels(22)),fill:'var(--warning-soft)',stroke:'var(--warning)','stroke-width':2,'stroke-dasharray':'4 3','data-suggested':name,tabindex:$('saveCorner').disabled?-1:0,role:'button','aria-disabled':String($('saveCorner').disabled),'aria-label':'Accept suggested '+name+' corner without movement'});
    if(name===focusedSuggestion)marker.focus({preventScroll:true});
    add('text',{x:cx,y:cy-pixels(28),'text-anchor':'middle','font-size':11,fill:'var(--warning)','pointer-events':'none'},'Accept '+name);
  }
  ps.forEach(p=>{
    const [cx,cy]=xy(p),i=names.indexOf(p.name);
    add('circle',{cx,cy,r:pixels(12),fill:'var(--surface)',stroke:'var(--accent)','stroke-width':2});
    add('text',{x:cx,y:cy+pixels(4),'text-anchor':'middle','font-size':8,fill:'var(--accent)'},['FL','FR','BR','BL'][i]);
    add('text',{x:cx,y:cy+(i<2?pixels(26):-pixels(22)),'text-anchor':'middle','font-size':11,fill:'var(--muted)'},p.x.toFixed(1)+', '+p.y.toFixed(1));
  });
  const pos=state.status?.machineCoord;
  if(pos){const [cx,cy]=xy(pos);add('circle',{cx,cy,r:5,fill:'var(--danger)',stroke:'var(--surface)','stroke-width':2});}
}
function plotTarget(e){
  if(!plotTransform||!state?.area)return null;
  const svg=$('plot'),matrix=svg.getScreenCTM();if(!matrix)return null;
  const point=svg.createSVGPoint();point.x=e.clientX;point.y=e.clientY;
  const local=point.matrixTransform(matrix.inverse()),t=plotTransform;
  let x=(local.x-t.ox)/t.scale+t.xmin,y=(t.oy-local.y)/t.scale+t.ymin;
  const corner=state.corners.find(p=>Math.hypot((p.x-x)*t.scale,(p.y-y)*t.scale)<14);
  if(corner){x=corner.x;y=corner.y;}
  const inside=['x','y'].every(a=>({x,y})[a]>=state.area[a][0]&&({x,y})[a]<=state.area[a][1]);
  return {x:Number(x.toFixed(3)),y:Number(y.toFixed(3)),inside};
}
$('attest').onchange=render;
$('arm').onclick=()=>call('arm',{confirmed:$('attest').checked});
$('stop').onclick=()=>{releaseHold();call('stop');};
$('fresh').onclick=$('newMap').onclick=()=>call('new-session');
$('checkConnection').onclick=()=>call('diagnostics');
$('report').onclick=async()=>{
  try{
    const r=await fetch('/api/report',{headers,signal:AbortSignal.timeout(3000)}),d=await r.json();if(!r.ok)throw Error(d.error);
    const url=URL.createObjectURL(new Blob([JSON.stringify(d,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='cnc-session-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
    a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){error('Report unavailable: '+e.message);}
};
$('speed').onchange=render;$('jogMode').onchange=render;$('fastHold').onchange=render;$('spacing').oninput=render;
function showMappingView(view){
  if(state?.phase!=='teach'||sending||state.busy||activeHold)return;
  if(view==='grid'&&(state.corners.length!==4||!state.area||state.geometryIssue))return;
  mappingView=view;
  if(view==='grid'&&draftGrid()?.error){
    const option=window.SurfaceGuide.gridChoices(state.area).find(p=>p.draft&&!p.draft.error);
    if(option)$('spacing').value=option.spacing;
  }
  render();document.querySelector('.mapping-inspector').scrollTop=0;
  if(matchMedia('(max-width:720px)').matches)document.querySelector('.mapping-inspector').scrollIntoView({block:'start'});
}
$('step1').onclick=$('backToArea').onclick=()=>showMappingView('teach');
$('step2').onclick=$('toPlanning').onclick=()=>showMappingView('grid');
$('completeRectangle').onclick=async()=>{
  if(await call('complete-rectangle',{area:state?.area}))showMappingView('grid');
};
document.querySelectorAll('[data-grid-choice]').forEach(b=>b.onclick=()=>{
  const option=window.SurfaceGuide.gridChoices(state?.area)[Number(b.dataset.gridChoice)];
  if(option&&!option.draft?.error){$('spacing').value=option.spacing;render();}
});
$('gridReturn').onclick=()=>{
  const pos=state?.status?.machineCoord;
  if(!pos||!state.area)return;
  const corner=[...state.corners].sort((a,b)=>Math.hypot(a.x-pos.x,a.y-pos.y)-Math.hypot(b.x-pos.x,b.y-pos.y))[0];
  if(corner)call('goto',{x:corner.x,y:corner.y,speed:$('speed').value});
};
$('copyMapPath').onclick=async()=>{
  if(!state?.result||state.demo)return;
  try{await navigator.clipboard.writeText(state.result.path);$('copyMapStatus').textContent='File path copied.';}
  catch{$('copyMapStatus').textContent='Copy unavailable. Select the file path above and copy it.';}
};
$('capture').onclick=async()=>{
  const corner=$('corner').value;
  if(await call('capture',{corner})){
    const missing=names.filter(n=>!state.corners.some(p=>p.name===n));
    const next=missing.includes(opposites[corner])?opposites[corner]:missing[0];
    if(next)$('corner').value=next;render();
  }
};
function fillCornerEntry(){
  const name=$('corner').value,recorded=state?.corners.find(p=>p.name===name);
  const [fb,lr]=name.split('-');
  const suggested=state?.area?{x:state.area.x[lr==='left'?0:1],y:state.area.y[fb==='front'?0:1]}:null;
  const point=recorded||suggested;
  $('cornerX').value=point?point.x:'';$('cornerY').value=point?point.y:'';
}
$('corner').onchange=()=>{fillCornerEntry();render();};$('clickMove').onchange=render;
$('gotoCorner').onclick=()=>{
  if(!state.area)return;const [fb,lr]=$('corner').value.split('-');
  call('goto',{x:state.area.x[lr==='left'?0:1],y:state.area.y[fb==='front'?0:1],speed:$('speed').value});
};
$('plot').onpointermove=e=>{
  const p=plotTarget(e);
  $('targetHint').textContent=p?.inside?'Target X '+number(p.x)+' · Y '+number(p.y)+' mm':'Machine coordinates · raised Z';
};
$('plot').onpointerleave=()=>{$('targetHint').textContent='Machine coordinates · raised Z';};
function acceptSuggested(name){
  if(!state?.area||$('saveCorner').disabled)return;
  const [fb,lr]=name.split('-');
  call('corner-entry',{corner:name,x:state.area.x[lr==='left'?0:1],y:state.area.y[fb==='front'?0:1]});
}
$('saveCorner').onclick=()=>{
  if(!$('cornerX').value.trim()||!$('cornerY').value.trim())return error('Enter both X and Y.');
  call('corner-entry',{corner:$('corner').value,x:Number($('cornerX').value),y:Number($('cornerY').value)});
};
$('plot').addEventListener('keydown',e=>{
  const name=e.target.getAttribute('data-suggested');
  if(name&&['Enter',' '].includes(e.key)){e.preventDefault();e.stopPropagation();acceptSuggested(name);}
});
$('plot').onclick=e=>{
  const suggested=e.target.getAttribute('data-suggested');
  if(suggested){acceptSuggested(suggested);return;}
  if(!$('clickMove').checked||$('clickMove').disabled||activeHold)return;
  const p=plotTarget(e);if(!p)return;
  if(!p.inside)return error('Choose a point inside the taught rectangle.');
  call('goto',{x:p.x,y:p.y,speed:$('speed').value});
};
$('reset').onclick=()=>call('reset-corners');
$('preview').onclick=()=>call('plan',{spacing:Number($('spacing').value)});
$('scan').onclick=()=>call('scan',{planId:state?.planId});
function ready(){if(!$('ready').disabled&&lastPrompt)call('reply',{id:lastPrompt.id,answer:lastPrompt.expected});}
$('ready').onclick=ready;
function jog(axis,sign){
  const step=Number($('distance').value);
  call('jog',{axis,delta:sign*(axis==='z'?Math.min(step,1):step),speed:$('speed').value});
}
async function holdControl(action,hold){
  try{
    const r=await fetch('/api/'+action,{method:'POST',headers,body:JSON.stringify({id:hold.id,sessionId:hold.sessionId}),signal:AbortSignal.timeout(1000)});
    if(!r.ok)throw Error((await r.json()).error);
  }catch(e){if(activeHold===hold){releaseHold();error('Held jog stopped: '+e.message);}}
}
function startHold(axis,sign,key=null,boost=false){
  if(activeHold||sending||!online||!state?.armed||state.busy||state.phase!=='teach')return;
  const b=document.querySelector('[data-axis="'+axis+'"][data-sign="'+sign+'"]');if(b.disabled)return;
  const speed=axis!=='z'&&(boost||$('fastHold').checked)?'maximum':$('speed').value;
  const hold=activeHold={id:crypto.randomUUID(),sessionId:state.sessionId,axis,sign,key,speed,timer:null};
  hold.timer=setInterval(()=>{if(activeHold===hold)holdControl('jog-pulse',hold);},150);
  call('jog-hold',{axis,delta:sign,id:hold.id,speed});
}
function releaseHold(){
  const hold=activeHold;if(!hold)return;
  activeHold=null;clearInterval(hold.timer);holdControl('jog-release',hold);render();
}
document.querySelectorAll('[data-axis]').forEach(b=>{
  b.onclick=()=>{if($('jogMode').value==='step')jog(b.dataset.axis,Number(b.dataset.sign));};
  b.onpointerdown=e=>{if($('jogMode').value!=='hold'||b.disabled)return;e.preventDefault();b.setPointerCapture(e.pointerId);startHold(b.dataset.axis,Number(b.dataset.sign));};
  b.onpointerup=releaseHold;b.onpointercancel=releaseHold;b.onlostpointercapture=releaseHold;
});
document.addEventListener('pointerup',()=>{if(activeHold&&!activeHold.key)releaseHold();});
window.addEventListener('blur',releaseHold);
window.addEventListener('pagehide',releaseHold);
document.addEventListener('visibilitychange',()=>{if(document.hidden)releaseHold();});
document.addEventListener('keyup',e=>{if(activeHold?.key===e.key){e.preventDefault();releaseHold();}});
document.addEventListener('keydown',e=>{
  if(e.repeat){if(['Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','PageUp','PageDown'].includes(e.key))e.preventDefault();return;}
  if(e.key==='Escape'){e.preventDefault();releaseHold();document.querySelectorAll('dialog[open]').forEach(d=>d.close());call('stop');return;}
  if(document.querySelector('dialog[open]')||document.querySelector('surface-command-menu')?.opened)return;
  if(!$('pcbWorkspace').hidden)return;
  const element=e.composedPath().find(n=>n instanceof HTMLElement&&(n.isContentEditable||['INPUT','SELECT','TEXTAREA','BUTTON','A','SUMMARY'].includes(n.tagName)))||document.activeElement;
  if(e.altKey||e.ctrlKey||e.metaKey||element.isContentEditable||['INPUT','SELECT','TEXTAREA'].includes(element.tagName))return;
  if(e.key==='Enter'){
    // Preserve native activation of the focused button, especially Stop.
    if(['BUTTON','A','SUMMARY'].includes(element.tagName))return;
    e.preventDefault();if(activeHold)return;
    if(state?.phase==='scan')ready();else if(state?.phase==='teach'&&!$('capture').disabled)$('capture').click();
    return;
  }
  const key={ArrowLeft:['x',-1],ArrowRight:['x',1],ArrowUp:['y',1],ArrowDown:['y',-1],PageUp:['z',1],PageDown:['z',-1]}[e.key];
  if(key){
    e.preventDefault();
    const b=document.querySelector('[data-axis="'+key[0]+'"][data-sign="'+key[1]+'"]');
    if(!b.disabled){if($('jogMode').value==='hold')startHold(...key,e.key,e.shiftKey);else b.click();}
  }
});
document.addEventListener('surface-release-input',releaseHold);
new ResizeObserver(()=>{if(state)draw();}).observe(document.querySelector('.surface-viewport'));
document.addEventListener('surface-view',()=>{if(state)draw();});
document.addEventListener('surface-theme',()=>{if(state)draw();pcbPanel?.draw();});
const cameraPanel=new CameraPanel();
$('utilityDialog').addEventListener('close',()=>cameraPanel.stop());
function showWorkspace(which){
  releaseHold();
  $('pcbWorkspace').hidden=which!=='pcb';$('surfaceWorkspace').hidden=which!=='surface';
  $('pcbTab').setAttribute('aria-selected',String(which==='pcb'));$('surfaceTab').setAttribute('aria-selected',String(which==='surface'));
  sessionStorage.setItem('surface-workspace',which);pcbPanel?.draw();window.SurfaceUI?.workspace(which);
  $('pcbTab').tabIndex=which==='pcb'?0:-1;$('surfaceTab').tabIndex=which==='surface'?0:-1;
}
$('pcbTab').onclick=()=>showWorkspace('pcb');$('surfaceTab').onclick=()=>showWorkspace('surface');
pcbPanel=new PcbPanel({call,getState:()=>state,getHeaders:()=>headers,reportError:error,showSurface:()=>showWorkspace('surface')});
showWorkspace(sessionStorage.getItem('surface-workspace')==='pcb'?'pcb':'surface');
render();setInterval(()=>poll(),750);poll();
