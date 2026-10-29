// 独立无账号的 Chromium 离线验证；不连接用户浏览器或 B 站。
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const assert=require('node:assert/strict');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'bili-sub-ui-'));
  const chrome=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
    '--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,
    '--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','about:blank'
  ],{windowsHide:true,stdio:'ignore'});
  let ws;
  try{
    let port;
    for(let i=0;i<60;i++){
      try{port=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break}catch{await delay(150)}
    }
    if(!port)throw Error('离线浏览器未启动');
    const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
    await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
    let id=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}))});
    const evaluate=async expression=>{
      const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||'页面执行失败');
      return r.result.value;
    };
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:pathToFileURL(path.resolve('tests/overlay-demo.html')).href});
    for(let i=0;i<60;i++){if(await evaluate('!!window.demo?.attempts'))break;await delay(100)}
    assert.equal(await evaluate('demo.attempts'),1);
    assert.equal(await evaluate('document.querySelector("#bili-sub-launcher").hidden'),true);
    assert.equal(await evaluate('document.querySelector("#bili-sub-overlay")===null'),true);
    await evaluate('demo.callbacks.onClose();demo.fail=true');
    const evidence=path.resolve('evidence/v0.7.0');await fs.mkdir(evidence,{recursive:true});
    for(const width of [1280,375]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
      const point=await evaluate(`(()=>{const b=document.querySelector('#bili-sub-launcher').shadowRoot.querySelector('button').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await delay(100);
      assert.match(await evaluate(`document.querySelector('#bili-sub-launcher').shadowRoot.querySelector('p').textContent`),/未安装/);
      const box=await evaluate(`(()=>{const b=document.querySelector('#bili-sub-launcher').getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,scale:1}})()`);
      assert.ok(box.x>=0 && box.x+box.width<=width);
      const shot=await send('Page.captureScreenshot',{format:'png',clip:box});await fs.writeFile(path.join(evidence,`launcher-${width}.png`),Buffer.from(shot.data,'base64'));
    }
    await evaluate('demo.fail=false;BiliSub.overlay.open()');
    assert.equal(await evaluate('document.querySelector("#bili-sub-launcher").hidden'),true);
    await fs.writeFile(path.join(evidence,'launcher-checks.json'),JSON.stringify({kind:'isolated-offline-chromium',automaticOpen:true,noInlineCaptions:true,retryButton:true,narrowNoOverflow:true}));
    console.log('[bili-sub] real-render PASS: global-only startup, failure and retry, narrow layout');
    await send('Browser.close').catch(()=>{});
  }finally{
    ws?.close();chrome.kill();
    // profile 是本脚本用 mkdtemp 创建的绝对临时目录，绝不指向用户浏览器资料。
    if(path.dirname(profile)===path.resolve(os.tmpdir()) && path.basename(profile).startsWith('bili-sub-ui-')){
      for(let i=0;i<5;i++){try{await fs.rm(profile,{recursive:true,force:true});break}catch{await delay(200)}}
    }
  }
})().catch(e=>{console.error(e);process.exitCode=1});
