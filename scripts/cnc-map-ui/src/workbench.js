import {LitElement, html, css} from 'lit';
import * as mappingGuide from './mapping-plan.js';
window.SurfaceGuide=mappingGuide;
import {createElement,Scan,Crosshair,Search,CircuitBoard,Camera,Activity,Terminal,Cpu,Contrast,Keyboard,Square,Move,Minus,Plus,Maximize,X,ArrowRight,ArrowLeft,ArrowUp,ArrowDown,FolderPlus,FileCode,Save,FolderOpen} from 'lucide';
const icons={crosshair:Crosshair,scan:Scan,search:Search,'circuit-board':CircuitBoard,camera:Camera,activity:Activity,terminal:Terminal,cpu:Cpu,contrast:Contrast,keyboard:Keyboard,square:Square,move:Move,minus:Minus,plus:Plus,maximize:Maximize,x:X,'arrow-right':ArrowRight,'arrow-left':ArrowLeft,'arrow-up':ArrowUp,'arrow-down':ArrowDown,'folder-plus':FolderPlus,'file-code':FileCode,save:Save,'folder-open':FolderOpen};
class SurfaceIcon extends LitElement{
  static properties={name:{type:String}};
  static styles=css`:host{display:inline-flex;width:100%;height:100%;align-items:center;justify-content:center}svg{display:block;width:100%;height:100%}`;
  render(){return icons[this.name]?createElement(icons[this.name],{'stroke-width':1.7,'aria-hidden':'true',focusable:'false'}):null;}
}
customElements.define('surface-icon',SurfaceIcon);
const commands=[
 {id:'surface',label:'Surface mapping',detail:'Corners, jogging and puck measurements',icon:'scan'},
 {id:'pcb',label:'PCB preparation',detail:'Files, placement, cutters and alignment',icon:'circuit-board'},
 {id:'camera',label:'Camera',detail:'Open the optional live-view controls',icon:'camera'},
 {id:'diagnostics',label:'Connection',detail:'Machine configuration, UGS connection and session details',icon:'activity'},
 {id:'log',label:'Session log',detail:'Show recent events and saved files',icon:'terminal'},
 {id:'shortcuts',label:'Keyboard shortcuts',detail:'Review navigation and operator controls',icon:'keyboard'}
];
class SurfaceCommandMenu extends LitElement{
  static properties={query:{state:true},selected:{state:true},opened:{state:true}};
  static styles=css`
    :host{font:13px var(--font);color:var(--ink)}dialog{padding:0;border:0;border-radius:10px;background:var(--surface);color:inherit;box-shadow:0 18px 65px #0005;width:min(520px,calc(100vw - 32px));margin-top:15vh}dialog::backdrop{background:#101a2480}header{display:flex;align-items:center;gap:10px;padding:16px;border-bottom:1px solid var(--line)}surface-icon{display:inline-flex;flex:0 0 18px;width:18px;height:18px}input{width:100%;min-width:0;font:14px var(--font);color:var(--ink);background:transparent;border:0;outline:none;caret-color:var(--accent)}input::placeholder{color:var(--muted)}.results{padding:6px;max-height:48vh;overflow:auto}button{font:12px var(--font);color:var(--ink);cursor:pointer;border:0;background:transparent;border-radius:5px}.item{display:flex;align-items:center;gap:12px;padding:12px;width:100%;text-align:left}.item[aria-selected=true],.item:hover{background:var(--accent-soft)}.item span{display:grid;gap:4px}.item small{color:var(--muted);font-size:11px}.item strong{font-weight:600}.close{padding:4px}.item:focus-visible,.close:focus-visible,.stop:focus-visible{outline:2px solid var(--accent);outline-offset:1px}footer{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding:10px 16px;color:var(--muted);font-size:11px}.stop{background:var(--danger);color:#fff;padding:8px 10px;font-weight:650}p{padding:16px;color:var(--muted)}
  `;
  constructor(){super();this.query='';this.selected=0;this.opened=false;}
  get matches(){return commands.filter(c=>(c.label+' '+c.detail).toLowerCase().includes(this.query.toLowerCase()));}
  async open(){this.query='';this.selected=0;this.opened=true;await this.updateComplete;const d=this.renderRoot.querySelector('dialog');if(!d.open)d.showModal();this.renderRoot.querySelector('input').focus();}
  close(){this.renderRoot.querySelector('dialog')?.close();this.opened=false;}
  choose(id){this.close();document.dispatchEvent(new CustomEvent('surface-navigation',{detail:id}));}
  stop(){document.getElementById('stop').click();this.close();}
  key(e){
    // Never let a search key become a machine jog or a readiness confirmation.
    e.stopPropagation();
    if(e.key==='Escape'){e.preventDefault();this.stop();return;}
    if(e.target.tagName!=='INPUT')return;
    if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();this.selected=(this.selected+(e.key==='ArrowDown'?1:-1)+this.matches.length)%Math.max(1,this.matches.length);}
    if(e.key==='Enter'){e.preventDefault();if(this.matches[this.selected])this.choose(this.matches[this.selected].id);}
  }
  render(){return html`<dialog aria-label="Find a tool" @keydown=${this.key} @cancel=${e=>{e.preventDefault();this.stop();}} @close=${()=>this.opened=false}>
    <header><surface-icon name="search"></surface-icon><input aria-label="Find a tool" placeholder="Find a view or tool…" .value=${this.query} @input=${e=>{this.query=e.target.value;this.selected=0;}}><button class="close" aria-label="Close tool search" @click=${this.close}><surface-icon name="x"></surface-icon></button></header>
    <div class="results" role="listbox" aria-label="Tools">${this.matches.map((c,i)=>html`<button class="item" role="option" aria-selected=${i===this.selected} @click=${()=>this.choose(c.id)}><surface-icon name=${c.icon}></surface-icon><span><strong>${c.label}</strong><small>${c.detail}</small></span></button>`)}${this.matches.length?'':html`<p>No tools match “${this.query}”.</p>`}</div>
    <footer><span>↑ ↓ to browse · Enter to open · Esc stops motion</span><button class="stop" @click=${this.stop}>Stop motion</button></footer></dialog>`;}
}
customElements.define('surface-command-menu',SurfaceCommandMenu);
const $=id=>document.getElementById(id);
const systemTheme=matchMedia('(prefers-color-scheme: dark)');
const stored=key=>{try{return localStorage.getItem(key);}catch{return null;}};
let appearance=['system','light','dark'].includes(stored('surface-appearance'))?stored('surface-appearance'):'system';
const theme=()=>{document.documentElement.dataset.theme=appearance==='system'?(systemTheme.matches?'dark':'light'):appearance;document.dispatchEvent(new Event('surface-theme'));};
// Called after the classic controller script has installed its own listeners.
function ready(){
  $('appearance').value=appearance;
  $('appearance').onchange=()=>{appearance=$('appearance').value;try{localStorage.setItem('surface-appearance',appearance);}catch{}theme();};
  systemTheme.addEventListener('change',()=>{if(appearance==='system')theme();});theme();
  const menu=document.querySelector('surface-command-menu');
  const release=()=>document.dispatchEvent(new Event('surface-release-input'));
  function utility(which){release();$('cameraPanel').hidden=which!=='camera';$('diagnosticsPanel').hidden=which!=='diagnostics';$('utilityTitle').textContent=which==='camera'?'Camera':'Connection & diagnostics';if(!$('utilityDialog').open)$('utilityDialog').showModal();}
  const toggleLog=()=>{$('sessionEvents').hidden=!$('sessionEvents').hidden;$('sessionEvents').open=!$('sessionEvents').hidden;};
  function shortcuts(){release();if(!$('shortcutsDialog').open)$('shortcutsDialog').showModal();}
  document.querySelectorAll('[data-utility]').forEach(b=>b.onclick=()=>utility(b.dataset.utility));
  $('openCommands').onclick=()=>{release();menu.open();};$('openShortcuts').onclick=shortcuts;
  $('closeUtility').onclick=()=>$('utilityDialog').close();$('closeShortcuts').onclick=()=>$('shortcutsDialog').close();
  $('openSession').onclick=$('statusLog').onclick=toggleLog;
  for(const dialog of [$('utilityDialog'),$('shortcutsDialog')]){
    const footer=document.createElement('div');footer.className='dialog-stop';
    const hint=document.createElement('span');hint.textContent='Use the physical stop if motion persists.';
    const stop=document.createElement('button');stop.className='stop';stop.textContent='Stop motion · Esc';stop.onclick=()=>{$('stop').click();dialog.close();};footer.append(hint,stop);dialog.append(footer);
    dialog.addEventListener('cancel',()=>{$('stop').click();});
  }
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(document.querySelector('dialog[open]'))return;release();menu.open();}});
  document.addEventListener('surface-navigation',e=>{if(e.detail==='surface'||e.detail==='pcb')$(e.detail+'Tab').click();else if(e.detail==='log')toggleLog();else if(e.detail==='shortcuts')shortcuts();else utility(e.detail);});
  let zoom=1;
  const view=()=>{const w=640/zoom,h=410/zoom;$('plot').setAttribute('viewBox',`${320-w/2} ${205-h/2} ${w} ${h}`);document.dispatchEvent(new Event('surface-view'));};
  $('surfaceZoomIn').onclick=()=>{zoom=Math.min(4,zoom*1.25);view();};$('surfaceZoomOut').onclick=()=>{zoom=Math.max(.5,zoom/1.25);view();};$('surfaceFit').onclick=()=>{zoom=1;view();};
  // Workspace tabs use the standard focus-only arrows; they never reach jogging.
  const tabs=[$('surfaceTab'),$('pcbTab')];
  tabs.forEach((b,i)=>b.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','ArrowRight','ArrowLeft','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const next=e.key==='Home'?0:e.key==='End'?1:1-i;tabs[next].focus();tabs[next].click();}}));
}
window.SurfaceUI={
  update(s,online,sending){
    if(!s)return;
    const enabled=online&&s.armed&&s.phase==='teach';
    $('shellState').textContent=!online?'App offline':s.phase==='stopped'?'Session stopped':enabled?'Teaching enabled':s.phase==='scan'?'Measuring':'Controls locked';
    $('shellState').dataset.ready=String(enabled);
    $('shellTask').textContent=s.prompt?'Waiting for operator':s.busy||sending?'Operation in progress':s.phase==='complete'?'Measurements saved':s.demo?'Simulation · no machine access':'UGS owns the machine connection';
    const p=s.status?.machineCoord;$('shellPosition').textContent=p?['X','Y','Z'].map(a=>a+' '+Number(p[a.toLowerCase()]).toFixed(3)).join('   '):'Machine XYZ —';
  },
  workspace(which){$('workspaceTitle').textContent=which==='pcb'?'PCB preparation':'Surface mapping';$('workspaceDescription').textContent=which==='pcb'?'Inspect toolpaths, place the board and prepare for UGS.':'Define the usable area. Measure the surface.';}
};
theme();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
