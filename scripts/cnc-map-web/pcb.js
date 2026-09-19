/* PCB preparation UI. Canvas interaction never issues machine movement. */
class PcbPanel {
  constructor({call,getState,getHeaders,reportError,showSurface}) {
    Object.assign(this,{call,getState,getHeaders,reportError,showSurface});
    this.job=null;this.loading=false;this.dirty=false;this.refDirty=false;this.pick=false;
    this.zoom=1;this.pan={x:0,y:0};this.visible=new Map();this.operationDrafts=new Map();this.flags={online:false,sending:false};
    this.canvas=document.getElementById('pcbCanvas');
    this.fields=['pcbName','pcbBoardRevision','pcbFace','pcbStockX','pcbStockY','pcbWidth','pcbHeight','pcbThickness','pcbMargin','pcbSpoil','pcbPlaceX','pcbPlaceY','pcbAngle','pcbMirror','pcbTolerance'];
    for(const id of this.fields)this.el(id).addEventListener('input',()=>{this.dirty=true;this.controls();});
    for(const id of ['pcbDesignX','pcbDesignY','pcbMachineX','pcbMachineY'])this.el(id).addEventListener('input',()=>{this.refDirty=true;this.controls();});
    this.el('pcbImport').onclick=()=>this.el('pcbFiles').click();
    this.el('pcbFiles').onchange=()=>this.importFiles();
    this.el('pcbOpen').onclick=()=>this.el('pcbPackageFile').click();
    this.el('pcbPackageFile').onchange=()=>this.openPackage();
    this.el('pcbExample').onclick=()=>this.post('pcb-example');
    this.el('pcbNew').onclick=()=>this.post('pcb-new');
    this.el('pcbApply').onclick=()=>this.apply();
    this.el('pcbUseArea').onclick=()=>this.post('pcb-stock-from-area');
    this.el('pcbRefLabel').onchange=()=>this.referenceForm();
    this.el('pcbReference').onclick=()=>this.reference(false);
    this.el('pcbCapture').onclick=()=>this.reference(true);
    this.el('pcbPick').onclick=()=>{this.pick=!this.pick;this.controls();};
    this.el('pcbOpenJog').onclick=showSurface;
    this.el('pcbSolve').onclick=()=>this.post('pcb-solve');
    this.el('pcbSave').onclick=()=>this.post('pcb-save',{},result=>{
      this.download(JSON.stringify(result.package,null,2),'pcb-job.json','application/json');
      this.el('pcbStatus').textContent=result.savedPath?'Saved on this Mac: '+result.savedPath:'Demo package downloaded; no measurements were saved.';
    });
    this.el('pcbLoadSaved').onclick=()=>this.post('pcb-load',{savedId:this.el('pcbSaved').value});
    this.el('pcbReviewed').onchange=()=>this.controls();
    this.el('pcbExport').onclick=()=>this.post('pcb-export',{reviewed:this.el('pcbReviewed').checked},result=>{
      const bytes=Uint8Array.from(atob(result.archive),c=>c.charCodeAt(0));
      this.download(bytes,result.filename,'application/zip');
      this.el('pcbStatus').textContent='Aligned draft downloaded. Open and inspect each operation in UGS; Z and height compensation still need review.';
    });
    this.el('pcbRapids').onchange=()=>this.draw();
    document.querySelectorAll('[data-pcb-section]').forEach(b=>{b.onclick=()=>this.el(b.dataset.pcbSection).scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'nearest'});});
    this.el('pcbZoomIn').onclick=()=>{this.zoom=Math.min(30,this.zoom*1.4);this.draw();};
    this.el('pcbZoomOut').onclick=()=>{this.zoom=Math.max(.3,this.zoom/1.4);this.draw();};
    this.el('pcbZoomFit').onclick=()=>{this.zoom=1;this.pan={x:0,y:0};this.draw();};
    this.canvas.onpointerdown=e=>{
      if(this.pick)return;
      this.drag={x:e.clientX,y:e.clientY,pan:{...this.pan}};this.canvas.setPointerCapture(e.pointerId);
    };
    this.canvas.onpointermove=e=>{
      if(this.drag){this.pan={x:this.drag.pan.x+e.clientX-this.drag.x,y:this.drag.pan.y+e.clientY-this.drag.y};this.draw();}
      const p=this.location(e);
      if(p)this.el('pcbCursor').textContent='Machine X '+p[0].toFixed(3)+' · Y '+p[1].toFixed(3)+' mm';
    };
    this.canvas.onpointerup=e=>{this.drag=null;if(this.pick)this.pickPoint(e);};
    this.canvas.onpointercancel=this.canvas.onlostpointercapture=()=>{this.drag=null;};
    this.canvas.addEventListener('wheel',e=>{
      if(!e.ctrlKey&&!e.metaKey)return;
      e.preventDefault();this.zoom=Math.max(.3,Math.min(30,this.zoom*(e.deltaY<0?1.15:.87)));this.draw();
    },{passive:false});
    new ResizeObserver(()=>this.draw()).observe(this.canvas);
  }
  el(id){return document.getElementById(id);}
  async update(state,flags){
    this.flags=flags;this.controls();
    if(state&&(!this.job||state.pcbRevision!==this.job.revision))await this.load();
    const p=state?.status?.machineCoord,key=p?JSON.stringify([p.x,p.y]):'';
    if(this.positionKey!==key){this.positionKey=key;this.draw();}
  }
  async load(){
    if(this.loading||!this.flags.online)return;
    this.loading=true;
    try{
      const response=await fetch('/api/pcb',{headers:this.getHeaders(),signal:AbortSignal.timeout(10000)});
      const data=await response.json();if(!response.ok)throw Error(data.error);
      const first=!this.job;this.job=data;
      if(this.resetSettings){this.dirty=false;this.resetSettings=false;}
      if(this.resetReference){this.refDirty=false;this.resetReference=false;}
      if(first||!this.dirty)this.settingsForm();
      this.renderJob();
    }catch(e){this.reportError('PCB workspace: '+e.message);}
    finally{this.loading=false;this.controls();}
  }
  async post(action,body={},receive=null){
    if(!this.job)return false;
    return this.call(action,{...body,pcbRevision:this.job.revision},result=>{
      const replaced=['pcb-new','pcb-load','pcb-example'].includes(action);
      this.resetSettings=replaced||['pcb-configure','pcb-solve','pcb-stock-from-area'].includes(action);
      this.resetReference=replaced||['pcb-import','pcb-configure','pcb-reference','pcb-capture','pcb-stock-from-area'].includes(action);
      if(replaced){this.operationDrafts.clear();this.visible.clear();this.pick=false;this.zoom=1;this.pan={x:0,y:0};}
      this.el('pcbReviewed').checked=false;
      if(receive)receive(result);
    });
  }
  controls(){
    const s=this.getState(),locked=!this.flags.online||this.flags.sending||this.loading||!!s?.busy;
    const live=!locked&&s?.armed&&s.phase==='teach',edits=this.dirty||this.refDirty||this.operationDrafts.size>0;
    for(const id of ['pcbImport','pcbOpen','pcbExample','pcbNew','pcbLoadSaved','pcbApply'])this.el(id).disabled=locked||!this.job;
    this.el('pcbSave').disabled=locked||edits||!this.job?.operations.length;
    this.el('pcbUseArea').disabled=!live||!s.area||this.dirty;
    this.el('pcbCapture').disabled=!live||this.dirty;
    this.el('pcbReference').disabled=locked||this.dirty;
    this.el('pcbSolve').disabled=locked||edits||!this.job?.operations.length;
    this.el('pcbExport').disabled=!live||edits||!this.job?.canExport||!this.el('pcbReviewed').checked;
    this.el('pcbPick').disabled=locked||this.dirty||!this.job?.operations.length;
    this.el('pcbPick').textContent=this.pick?'Click a known point…':'Pick on preview';
    this.canvas.classList.toggle('picking',this.pick);
    this.el('pcbDirty').hidden=!this.dirty;
    this.el('pcbCaptureHint').textContent=live?'Capture reads the stationary cutter position; it does not move the machine.':
      'Enable teaching in Jog & surface mapping to capture live references. Manual coordinates remain a draft.';
    for(const control of this.el('pcbOperations').querySelectorAll('button,input,select'))control.disabled=locked;
    for(const id of [...this.fields,'pcbRefLabel','pcbDesignX','pcbDesignY','pcbMachineX','pcbMachineY'])this.el(id).disabled=locked;
  }
  settingsForm(){
    const j=this.job,s=j.stock,p=j.placement;
    const values={pcbName:j.name,pcbBoardRevision:j.boardRevision,pcbFace:j.face,pcbStockX:s.x,pcbStockY:s.y,pcbWidth:s.width,pcbHeight:s.height,
      pcbThickness:s.thickness,pcbMargin:s.margin,pcbSpoil:s.spoilAllowance,pcbPlaceX:p.x,pcbPlaceY:p.y,pcbAngle:p.angle,pcbTolerance:j.tolerance};
    for(const [id,value] of Object.entries(values))this.el(id).value=typeof value==='number'?Number(value.toFixed(6)):value;
    this.el('pcbMirror').checked=p.mirror;
  }
  async apply(){
    const n=id=>Number(this.el(id).value);
    if(this.fields.some(id=>this.el(id).type==='number'&&(this.el(id).value===''||!Number.isFinite(n(id)))))return this.reportError('Fill in every numeric setup field.');
    await this.post('pcb-configure',{settings:{name:this.el('pcbName').value,boardRevision:this.el('pcbBoardRevision').value,face:this.el('pcbFace').value,
      stock:{x:n('pcbStockX'),y:n('pcbStockY'),width:n('pcbWidth'),height:n('pcbHeight'),thickness:n('pcbThickness'),margin:n('pcbMargin'),spoilAllowance:n('pcbSpoil')},
      placement:{x:n('pcbPlaceX'),y:n('pcbPlaceY'),angle:n('pcbAngle'),mirror:this.el('pcbMirror').checked},tolerance:n('pcbTolerance')}});
  }
  async importFiles(){
    try{
      const files=[...this.el('pcbFiles').files];if(!files.length)return;
      if(files.length>12||files.some(f=>f.size>4000000)||files.reduce((n,f)=>n+f.size,0)>16000000)throw Error('Use up to 12 files, 4 MB each and 16 MB total.');
      const contents=await Promise.all(files.map(async f=>({name:f.name,source:await f.text()})));
      await this.post('pcb-import',{files:contents});
    }catch(e){this.reportError(e.message);}
    finally{this.el('pcbFiles').value='';}
  }
  async openPackage(){
    try{
      const file=this.el('pcbPackageFile').files[0];if(!file)return;
      if(file.size>24000000)throw Error('Job package exceeds 24 MB.');
      await this.post('pcb-load',{package:JSON.parse(await file.text())});
    }catch(e){this.reportError('Cannot open package: '+e.message);}
    finally{this.el('pcbPackageFile').value='';}
  }
  referenceForm(){
    const ref=this.job?.references[this.el('pcbRefLabel').value];
    for(const [id,value] of [['pcbDesignX',ref?.design?.[0]],['pcbDesignY',ref?.design?.[1]],['pcbMachineX',ref?.machine?.[0]],['pcbMachineY',ref?.machine?.[1]]])
      this.el(id).value=value==null?'':Number(value.toFixed(6));
    this.refDirty=false;this.controls();
  }
  async reference(capture){
    const pair=ids=>ids.map(id=>this.el(id).value===''?null:Number(this.el(id).value));
    const design=pair(['pcbDesignX','pcbDesignY']),machine=pair(['pcbMachineX','pcbMachineY']);
    if(design.some(v=>v===null||!Number.isFinite(v)))return this.reportError('Enter both design coordinates for this reference.');
    if(!capture&&machine.some(v=>v===null||!Number.isFinite(v)))return this.reportError('Enter both observed machine coordinates, or capture the cutter position.');
    await this.post(capture?'pcb-capture':'pcb-reference',{label:this.el('pcbRefLabel').value,design,...(capture?{}:{machine})});
  }
  renderJob(){
    const j=this.job;
    this.el('pcbStatus').textContent=j.note+(j.lastSaved?' Last saved: '+j.lastSaved:'');
    this.el('pcbSummary').textContent=j.operations.length?j.operations.length+' operations · '+j.face+' face · '+(j.placement.mirror?'X mirrored':'Original handedness'):'Add existing CAM G-code to begin.';
    const fit=j.operations.length&&j.operations.every(o=>o.fits);
    this.el('pcbFit').textContent=!j.operations.length?'NO FILES':!fit?'OUTSIDE STOCK':j.operations.some(o=>o.diameter===null)?'SET CUTTER SIZES':'FITS DECLARED STOCK';
    this.el('pcbFit').classList.toggle('failed',!!j.operations.length&&!fit);
    this.el('pcbOperations').replaceChildren();
    for(const id of this.operationDrafts.keys())if(!j.operations.some(o=>o.id===id))this.operationDrafts.delete(id);
    j.operations.forEach((op,index)=>{
      const row=document.createElement('article');row.className='pcb-operation';
      const heading=document.createElement('h3');heading.textContent=(index+1)+'. '+op.name;
      const detail=document.createElement('p');detail.className='micro';
      detail.textContent='Depth '+Math.max(0,-op.cutBounds.z[0]).toFixed(3)+' mm · '+op.feedMinutes.toFixed(1)+' min feed motion (excludes rapids, pauses and setup) · '+(op.diameter===null?'Cutter size needed for footprint check':op.fits?'Footprint inside margin':'Footprint outside margin');
      const controls=document.createElement('div');controls.className='pcb-operation-fields';
      const visible=document.createElement('input');visible.type='checkbox';visible.checked=this.visible.get(op.id)!==false;
      const show=document.createElement('label');show.className='pcb-visible';show.append(visible,document.createTextNode(' Show'));
      visible.onchange=()=>{this.visible.set(op.id,visible.checked);this.draw();};
      const role=document.createElement('select');role.setAttribute('aria-label','Operation type for '+op.name);
      for(const name of ['isolation','drilling','outline','clearing','other'])role.add(new Option(name,name));
      const draft=this.operationDrafts.get(op.id)||op;
      role.value=draft.role;
      const tool=document.createElement('input');tool.type='text';tool.value=draft.tool;tool.placeholder='Cutter description';tool.maxLength=120;tool.setAttribute('aria-label','Cutter for '+op.name);
      const diameter=document.createElement('input');diameter.type='number';diameter.step='any';diameter.value=draft.diameter??'';diameter.placeholder='Effective Ø mm';diameter.setAttribute('aria-label','Cutting diameter for '+op.name);
      const edited=()=>{this.operationDrafts.set(op.id,{role:role.value,tool:tool.value,diameter:diameter.value});this.controls();};
      role.onchange=tool.oninput=diameter.oninput=edited;
      const save=document.createElement('button');save.textContent='Save cutter';save.onclick=()=>this.post('pcb-operation',{id:op.id,role:role.value,tool:tool.value,diameter:diameter.value===''?null:Number(diameter.value)},()=>this.operationDrafts.delete(op.id));
      const diameterLabel=document.createElement('label');diameterLabel.className='diameter-field';
      const diameterCaption=document.createElement('span');diameterCaption.textContent='Effective Ø (mm)';diameterLabel.append(diameterCaption,diameter);
      controls.append(show,role,tool,diameterLabel,save);
      for(const [label,action] of [['↑','up'],['↓','down'],['Remove','remove']]){
        const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-label',action+' '+op.name);
        b.onclick=()=>this.post('pcb-operation',{id:op.id,action});controls.append(b);
      }
      const hash=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('p');
      summary.textContent='Source checks';body.className='micro';body.textContent='SHA-256 '+op.sha256+'. '+op.warnings.join(' ');hash.append(summary,body);
      row.append(heading,detail,controls,hash);this.el('pcbOperations').append(row);
    });
    if(!j.operations.length){const p=document.createElement('p');p.textContent='No files loaded. Gerber and Excellon files need CAM conversion before import.';this.el('pcbOperations').append(p);}
    this.el('pcbReferenceTable').replaceChildren();
    for(const [label,point] of Object.entries(j.references)){
      const row=document.createElement('div'),name=document.createElement('strong'),value=document.createElement('span');
      name.textContent=label;
      value.textContent=point.design?'Design '+point.design.map(v=>v.toFixed(3)).join(', ')+' → '+(point.machine?point.machine.map(v=>v.toFixed(3)).join(', ')+' ('+(point.session?'captured':'draft')+')':'not captured'):'Not taught';
      row.append(name,value);this.el('pcbReferenceTable').append(row);
    }
    if(!this.refDirty)this.referenceForm();
    this.el('pcbAlignmentResult').textContent=j.alignment?
      (j.alignment.status==='captured'?'Captured alignment':'Draft alignment')+' · rotation '+j.placement.angle.toFixed(4)+'° · A–B spacing error '+j.alignment.baselineError.toFixed(3)+' mm · C error '+(j.alignment.checkError==null?'not checked':j.alignment.checkError.toFixed(3)+' mm'):'Alignment has not been checked.';
    this.el('pcbIssues').replaceChildren();
    for(const issue of j.issues.length?j.issues:['Geometry checks passed. Continue with Z, compensation and the physical setup review in UGS.']){
      const li=document.createElement('li');li.textContent=issue;this.el('pcbIssues').append(li);
    }
    this.el('pcbScanArea').textContent=j.cutBounds?'Toolpath bounds in machine XY: X '+j.cutBounds.x.map(n=>n.toFixed(3)).join(' to ')+'; Y '+j.cutBounds.y.map(n=>n.toFixed(3)).join(' to ')+' mm. Cover these paths when planning the copper scan.':'Toolpath bounds will appear after files are loaded.';
    this.el('pcbSaved').replaceChildren();
    for(const saved of j.savedJobs||[])this.el('pcbSaved').add(new Option(saved.label,saved.id));
    this.el('pcbResume').hidden=!j.savedJobs?.length;
    this.el('pcbReviewed').checked=false;this.controls();this.draw();
  }
  download(data,name,type){
    const url=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  location(e){
    if(!this.view)return null;
    const box=this.canvas.getBoundingClientRect(),t=this.view;
    return [(e.clientX-box.left-t.ox)/t.scale+t.cx,(t.oy-(e.clientY-box.top))/t.scale+t.cy];
  }
  pickPoint(e){
    let p=this.location(e);if(!p||!this.job)return;
    let nearest=null,distance=12/this.view.scale;
    for(const op of this.job.operations)for(const path of op.paths)for(const point of path.points){
      const d=Math.hypot(p[0]-point[0],p[1]-point[1]);
      if(d<distance){nearest=point;distance=d;}
    }
    if(nearest)p=nearest;
    const t=this.job.placement,a=t.angle*Math.PI/180,x=p[0]-t.x,y=p[1]-t.y;
    let dx=Math.cos(a)*x+Math.sin(a)*y,dy=-Math.sin(a)*x+Math.cos(a)*y;
    if(t.mirror)dx=-dx;
    this.el('pcbDesignX').value=Number(dx.toFixed(6));this.el('pcbDesignY').value=Number(dy.toFixed(6));
    this.refDirty=true;this.pick=false;this.controls();
    this.el('pcbStatus').textContent=nearest?'Selected an actual toolpath point. Match it to the same physical reference.':'Approximate point selected. Enter exact design coordinates before capturing.';
  }
  draw(){
    if(!this.job||this.el('pcbWorkspace').hidden)return;
    const canvas=this.canvas,w=canvas.clientWidth,h=canvas.clientHeight;if(!w||!h)return;
    const ratio=Math.min(devicePixelRatio||1,2);canvas.width=w*ratio;canvas.height=h*ratio;
    const ctx=canvas.getContext('2d');ctx.setTransform(ratio,0,0,ratio,0,0);
    const j=this.job,s=j.stock,b=j.bounds;
    const xmin=Math.min(s.x,b?.x[0]??s.x),xmax=Math.max(s.x+s.width,b?.x[1]??s.x+s.width);
    const ymin=Math.min(s.y,b?.y[0]??s.y),ymax=Math.max(s.y+s.height,b?.y[1]??s.y+s.height);
    const scale=Math.min((w-80)/(xmax-xmin||1),(h-80)/(ymax-ymin||1))*this.zoom;
    const cx=(xmin+xmax)/2,cy=(ymin+ymax)/2,ox=w/2+this.pan.x,oy=h/2+this.pan.y;
    this.view={scale,cx,cy,ox,oy};
    const point=p=>[ox+(p[0]-cx)*scale,oy-(p[1]-cy)*scale];
    const theme=getComputedStyle(document.documentElement),colour=name=>theme.getPropertyValue('--'+name).trim();
    ctx.fillStyle=colour('canvas');ctx.fillRect(0,0,w,h);
    const [left,top]=point([s.x,s.y+s.height]);
    ctx.fillStyle=colour('stock');ctx.fillRect(left,top,s.width*scale,s.height*scale);
    ctx.strokeStyle=colour('stock-line');ctx.lineWidth=1;ctx.strokeRect(left,top,s.width*scale,s.height*scale);
    ctx.setLineDash([5,5]);ctx.strokeStyle=colour('stock-line');
    ctx.strokeRect(left+s.margin*scale,top+s.margin*scale,(s.width-2*s.margin)*scale,(s.height-2*s.margin)*scale);ctx.setLineDash([]);
    ctx.fillStyle=colour('muted');ctx.font='11px ui-monospace,monospace';
    ctx.fillText(s.width.toFixed(1)+' × '+s.height.toFixed(1)+' mm stock',left,top-12);
    const colours={isolation:colour('isolation'),drilling:colour('drilling'),outline:colour('outline'),clearing:colour('clearing'),other:colour('accent')};
    for(const op of j.operations){
      if(this.visible.get(op.id)===false)continue;
      for(const rapid of [true,false]){
        if(rapid&&!this.el('pcbRapids').checked)continue;
        ctx.beginPath();ctx.strokeStyle=rapid?colour('line-strong'):colours[op.role];ctx.lineWidth=rapid?.7:1.2;ctx.setLineDash(rapid?[3,4]:[]);
        for(const path of op.paths){
          if(path.rapid!==rapid)continue;
          path.points.forEach((p,i)=>{const q=point(p);if(i)ctx.lineTo(...q);else ctx.moveTo(...q);});
        }
        ctx.stroke();ctx.setLineDash([]);
      }
      ctx.fillStyle=colours[op.role];
      for(const path of op.paths){
        const first=path.points[0],last=path.points.at(-1);
        if(!path.rapid&&last[2]<0&&first[0]===last[0]&&first[1]===last[1]){
          const [x,y]=point(last);ctx.beginPath();ctx.arc(x,y,2,0,Math.PI*2);ctx.fill();
        }
      }
    }
    const origin=point([j.placement.x,j.placement.y]);ctx.strokeStyle=colour('ink');ctx.lineWidth=1.5;
    ctx.beginPath();ctx.moveTo(origin[0]-7,origin[1]);ctx.lineTo(origin[0]+7,origin[1]);ctx.moveTo(origin[0],origin[1]-7);ctx.lineTo(origin[0],origin[1]+7);ctx.stroke();
    for(const [label,p] of Object.entries(j.references)){
      if(!p.machine)continue;const [x,y]=point(p.machine);
      ctx.fillStyle=p.session?colour('accent'):colour('warning');ctx.beginPath();ctx.arc(x,y,6,0,Math.PI*2);ctx.fill();
      ctx.fillStyle=colour('ink');ctx.font='bold 12px system-ui';ctx.fillText(label,x+9,y-8);
    }
    const machine=this.getState()?.status?.machineCoord;
    if(machine){const [x,y]=point([machine.x,machine.y]);ctx.fillStyle=colour('danger');ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();}
    if(!j.operations.length){ctx.fillStyle=colour('muted');ctx.textAlign='center';ctx.font='14px system-ui';ctx.fillText('Add cutting files to preview the PCB',w/2,h/2);ctx.textAlign='left';}
  }
}
