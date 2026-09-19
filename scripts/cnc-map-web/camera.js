/* Optional browser-only preview. No capture, upload, or machine-control integration. */
class CameraPanel {
  constructor() {
    this.stream=null; this.generation=0; this.pending=false;
    this.video=document.getElementById('cameraVideo');
    this.startButton=document.getElementById('cameraStart');
    this.stopButton=document.getElementById('cameraStop');
    this.device=document.getElementById('cameraDevice');
    this.startButton.onclick=()=>this.start();
    this.stopButton.onclick=()=>this.stop();
    this.device.onchange=()=>this.stop('Camera selection changed. Enable it when ready.');
    window.addEventListener('pagehide',()=>this.stop());
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.stop('Camera paused because the page was hidden. Enable it to resume.');});
  }
  update(message) {
    this.startButton.disabled=this.pending||!!this.stream;
    this.stopButton.disabled=!this.pending&&!this.stream;
    this.device.disabled=this.pending||!!this.stream;
    document.getElementById('cameraFrame').hidden=!this.stream;
    document.getElementById('cameraState').textContent=this.stream?'LIVE':this.pending?'WAITING':'OFF';
    document.getElementById('cameraHelp').textContent=message;
  }
  stop(message='Camera off. Video is not recorded or uploaded.') {
    this.generation++;
    this.stream?.getTracks().forEach(track=>track.stop());
    this.stream=null; this.pending=false; this.video.srcObject=null;
    this.update(message);
  }
  async start() {
    if(this.pending||this.stream)return;
    const generation=++this.generation;
    this.pending=true;this.update('Allow camera access in your browser, or choose Turn off to cancel.');
    let stream;
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw Error('Camera access is unavailable here. Open this local page in a browser with camera support.');
      const video={width:{ideal:1280},height:{ideal:720},frameRate:{ideal:15,max:30}};
      if(this.device.value)video.deviceId={exact:this.device.value};
      stream=await navigator.mediaDevices.getUserMedia({video,audio:false});
      // A permission prompt can resolve after cancellation or a hidden page.
      if(generation!==this.generation||document.hidden){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;this.pending=false;this.video.srcObject=stream;
      stream.getVideoTracks().forEach(t=>t.addEventListener('ended',()=>{if(this.stream===stream)this.stop('Camera disconnected. Reconnect it, then enable the camera again.');}));
      await this.video.play();
      if(generation!==this.generation)return;
      this.update('Live view only. Crosshair is not aligned to the cutter; video stays in this browser.');
      try {
        const devices=await navigator.mediaDevices.enumerateDevices();
        if(generation!==this.generation)return;
        const selected=stream.getVideoTracks()[0]?.getSettings().deviceId;
        this.device.replaceChildren(new Option('Default camera',''));
        devices.filter(d=>d.kind==='videoinput').forEach((d,i)=>this.device.add(new Option(d.label||`Camera ${i+1}`,d.deviceId)));
        this.device.value=selected||'';
      }catch{/* Device names are optional; preview remains usable. */}
    }catch(e){
      stream?.getTracks().forEach(t=>t.stop());
      if(generation!==this.generation)return;
      const messages={NotAllowedError:'Camera permission was denied. You can enable it in browser settings; CNC controls are unaffected.',NotFoundError:'No camera found. Connect a USB camera and try again.',NotReadableError:'Camera is busy or unavailable. Close other camera apps and try again.',OverconstrainedError:'The selected camera is unavailable. Select another camera.'};
      this.stop(messages[e.name]||e.message);
    }
  }
}
