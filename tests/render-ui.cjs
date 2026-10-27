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
    for(let i=0;i<60;i++){if(await evaluate('!!window.BiliSub?.overlay && !!document.querySelector("#bili-sub-overlay")'))break;await delay(100)}
    await evaluate('P.pause(); P.seekTo(6);'); await delay(350);
    const read=`(()=>{const h=document.querySelector('#bili-sub-overlay'),r=h.shadowRoot,b=h.getBoundingClientRect();return {left:b.left,top:b.top,width:b.width,height:b.height,revealed:h.dataset.revealed,opacity:getComputedStyle(r.querySelector('.toolbar')).opacity,alpha:getComputedStyle(h).getPropertyValue('--surface-alpha').trim(),overflow:r.querySelector('.toolbar').scrollWidth>b.width,current:r.querySelector('.active')?.textContent,bodyScroll:document.scrollingElement.scrollTop,lyricsHeight:r.querySelector('.lyrics').getBoundingClientRect().height}})()`;
    const before=await evaluate(read);
    assert.equal(before.width,760);assert.equal(before.height,192);assert.equal(before.opacity,'0');assert.equal(before.alpha,'0');assert.equal(before.bodyScroll,0);
    const evidence=path.resolve('evidence');await fs.mkdir(evidence,{recursive:true});
    const screenshot=async name=>{
      const b=await evaluate(`(()=>{const b=document.querySelector('#bili-sub-overlay').getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,scale:1}})()`);
      const result=await send('Page.captureScreenshot',{format:'png',clip:b,captureBeyondViewport:false});await fs.writeFile(path.join(evidence,name),Buffer.from(result.data,'base64'));
    };
    const pointFor=selector=>evaluate(`(()=>{const b=document.querySelector('#bili-sub-overlay').shadowRoot.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    const click=async selector=>{
      const p=await pointFor(selector);await send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});await delay(180);
    };
    const change=(label,value,type='input')=>evaluate(`(()=>{const input=document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('[aria-label="${label}"]');input.value=${JSON.stringify(String(value))};input.dispatchEvent(new Event('${type}',{bubbles:true}))})()`);
    const drag=async(selector,dx,dy)=>{
      const p=await pointFor(selector);await send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});
      for(let i=1;i<=5;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+dx*i/5,y:p.y+dy*i/5,button:'left',buttons:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x+dx,y:p.y+dy,button:'left',clickCount:1});await delay(100);
    };
    const backingCheck=await evaluate(`(()=>{const r=document.querySelector('#bili-sub-overlay').shadowRoot,a=r.querySelector('.active'),b=[...r.querySelectorAll('.line')].find(n=>!n.classList.contains('active'));return {active:getComputedStyle(a).backgroundColor,normal:getComputedStyle(b).backgroundColor,activeInk:getComputedStyle(a).color,normalInk:getComputedStyle(b).color,underline:getComputedStyle(a).textDecorationLine,plain:getComputedStyle(b).textDecorationLine}})()`);
    assert.equal(backingCheck.active,backingCheck.normal);assert.equal(backingCheck.active,'rgba(247, 244, 237, 0.9)');assert.equal(backingCheck.activeInk,backingCheck.normalInk);assert.equal(backingCheck.underline,'underline');assert.equal(backingCheck.plain,'none');
    await screenshot('ui-v6-idle.png');
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:850,y:600});await delay(250);
    const hovered=await evaluate(read);assert.equal(hovered.opacity,'1');assert.ok(before.lyricsHeight>=before.height-12);assert.ok(before.lyricsHeight>hovered.lyricsHeight+50);await screenshot('ui-v6-hover.png');
    assert.equal(await evaluate(`document.querySelector('#bili-sub-overlay').shadowRoot.textContent.includes('普通小窗')`),false);
    // 用真实鼠标点击设置，再离开：不能因为按钮仍有焦点而常驻。
    const point=await evaluate(`(()=>{const b=document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('[aria-label="外观设置"]').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await delay(250);
    assert.equal(await evaluate(`document.querySelector('#bili-sub-overlay').dataset.settings`),'true');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('.settings-panel')).opacity`),'1');
    await screenshot('ui-v6-settings.png');
    const panelCheck=await evaluate(`(()=>{const r=document.querySelector('#bili-sub-overlay').shadowRoot,p=r.querySelector('.settings-panel'),s=r.querySelector('.settings-body');return {opaque:getComputedStyle(p).backgroundColor,scrollable:s.scrollHeight>s.clientHeight,header:r.querySelector('.settings-header').getBoundingClientRect().height}})()`);
    assert.equal(panelCheck.opaque,'rgb(247, 244, 237)');assert.equal(panelCheck.scrollable,true);assert.ok(panelCheck.header>=40);
    await change('字幕排版','lines','change');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('.cue-row')).display`),'block');
    await change('字幕排版','flow','change');
    await evaluate(`(()=>{const a=document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('[aria-label="窗口透明度"]');a.value='100';a.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal((await evaluate(read)).alpha,'0');
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:40,y:40});await delay(250);
    const after=await evaluate(read);assert.equal(after.opacity,'0');assert.equal(after.lyricsHeight,before.lyricsHeight);
    assert.equal(await evaluate(`document.querySelector('#bili-sub-overlay').dataset.settings`),'false');
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:850,y:600});await delay(180);
    await drag('.drag-handle',-180,-180);
    const moved=await evaluate(read);assert.equal(Math.round(moved.left),Math.round(before.left-180));assert.equal(Math.round(moved.top),Math.round(before.top-180));
    await drag('.resize-se',80,70);
    const resized=await evaluate(read);assert.equal(Math.round(resized.width),840);assert.equal(Math.round(resized.height),262);
    await screenshot('ui-v6-resized.png');
    // 重新加载后偏好仍然有效。
    await send('Page.reload');await delay(250);
    const restored=await evaluate(read);assert.equal(restored.alpha,'0');assert.equal(restored.width,840);assert.equal(restored.left,moved.left);
    await evaluate('P.pause();P.seekTo(6)');
    await evaluate(`document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('[aria-label="重置字幕框位置和大小"]').click()`);
    const sample=Array.from({length:80},(_,i)=>({start:i*3,end:i*3+3,text:`这是第${i+1}句短字幕，保留时间轴。`}));
    await evaluate(`BiliSub.overlay.setCues(${JSON.stringify(sample)});P.seekTo(60)`);await delay(350);
    const countVisible=`(()=>{const r=document.querySelector('#bili-sub-overlay').shadowRoot,v=r.querySelector('.lyrics').getBoundingClientRect();return [...r.querySelectorAll('.line')].filter(n=>[...n.getClientRects()].some(b=>b.bottom>v.top&&b.top<v.bottom)).length})()`;
    const density18=await evaluate(countVisible);
    const sharedLine=await evaluate(`(()=>{const a=[...document.querySelector('#bili-sub-overlay').shadowRoot.querySelectorAll('.line')];return a.some((n,i)=>i>0&&n.getClientRects()[0].top===a[i-1].getClientRects()[0].top)})()`);assert.equal(sharedLine,true);
    await change('字幕字号',14);await delay(200);
    const density14=await evaluate(countVisible);assert.ok(density14>density18,JSON.stringify({density14,density18}));
    await screenshot('ui-v6-dense.png');
    const longText='这是一句很长的字幕，用于检查自动换行后可以完整阅读，保持原本的时间轴和点击跳转。'.repeat(25);
    await evaluate(`BiliSub.overlay.setCues([{start:0,end:20,text:${JSON.stringify(longText)}},{start:21,end:25,text:'下一句字幕。'}]);P.seekTo(1)`);await delay(350);
    const long=await evaluate(`(()=>{const r=document.querySelector('#bili-sub-overlay').shadowRoot,v=r.querySelector('.lyrics'),a=r.querySelector('.active'),rects=[...a.getClientRects()];return {text:a.textContent,lines:rects.length,firstTop:rects[0].top,viewTop:v.getBoundingClientRect().top,overflow:v.scrollHeight>v.clientHeight}})()`);
    assert.equal(long.text,longText);assert.ok(long.lines>5);assert.ok(long.firstTop>=long.viewTop-2);assert.equal(long.overflow,true);
    const lp=await pointFor('.lyrics');await send('Input.dispatchMouseEvent',{type:'mouseMoved',...lp});
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',...lp,deltaX:0,deltaY:90});await delay(200);
    const scrollBefore=await evaluate(`document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('.lyrics').scrollTop`);
    await evaluate('P.seekTo(22)');await delay(200);
    assert.equal(await evaluate(`document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('.lyrics').scrollTop`),scrollBefore);
    await click('[aria-label="恢复自动跟随当前字幕"]');
    assert.equal(await evaluate(`document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('[aria-label="恢复自动跟随当前字幕"]').hidden`),true);
    await change('字幕字号',18);await change('窗口透明度',95);
    await evaluate('full();P.seekTo(6)');await change('字幕配色','night','change');
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:40,y:40});await delay(250);await screenshot('ui-v6-night.png');
    await change('字幕配色','paper','change');
    await change('窗口透明度',100);
    await evaluate(`(()=>{const backdrop=document.createElement('div');backdrop.id='fake-background';backdrop.style.cssText='position:fixed;inset:0;z-index:1;background:#fff;color:#222;font:23px/1.6 system-ui;pointer-events:none;overflow:hidden';backdrop.textContent=('模拟背景文字  表格内容  这不是桌面截图  '.repeat(500));document.body.append(backdrop)})()`);
    await screenshot('ui-v6-busy-background.png');
    await change('字幕排版','lines','change');await delay(200);await screenshot('ui-v6-lines-background.png');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#bili-sub-overlay').shadowRoot.querySelector('.line')).display`),'inline');
    await change('字幕配色','night','change');await screenshot('ui-v6-dark-background.png');
    await change('字幕排版','flow','change');await change('字幕配色','paper','change');
    await evaluate(`document.querySelector('#fake-background').remove()`);
    await send('Emulation.setDeviceMetricsOverride',{width:375,height:720,deviceScaleFactor:1,mobile:false});await delay(250);
    const narrow=await evaluate(read);assert.ok(narrow.width<=359);assert.equal(narrow.overflow,false);
    await screenshot('ui-v6-narrow.png');
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:180,y:620});await delay(250);
    await screenshot('ui-v6-narrow-hover.png');
    await click('[aria-label="外观设置"]');
    await screenshot('ui-v6-narrow-settings.png');
    assert.equal(await evaluate(`(()=>{const r=document.querySelector('#bili-sub-overlay').shadowRoot,s=r.querySelector('.settings-body');return s.scrollWidth<=s.clientWidth})()`),true);
    await fs.writeFile(path.join(evidence,'ui-v6-checks.json'),JSON.stringify({kind:'isolated-offline-chromium',before,backingCheck,hovered,panelCheck,after,moved,resized,restored,narrow,density18,density14,longLines:long.lines,checks:['idle full frame restored after hover','pointer drag and edge resize','geometry persistence','shared-line sentences','smaller font shows more cues','long cue complete and aligned from start','wheel suspends following','resume following','popup removed','375px no toolbar overflow']},null,2));
    console.log('[bili-sub] real-render PASS: full-frame idle subtitles, drag, resize, restore geometry, text flow, density, long cue, manual scrolling, removed popup');
    await send('Browser.close').catch(()=>{});
  }finally{
    ws?.close();chrome.kill();
    // profile 是本脚本用 mkdtemp 创建的绝对临时目录，绝不指向用户浏览器资料。
    if(path.dirname(profile)===path.resolve(os.tmpdir()) && path.basename(profile).startsWith('bili-sub-ui-')){
      for(let i=0;i<5;i++){try{await fs.rm(profile,{recursive:true,force:true});break}catch{await delay(200)}}
    }
  }
})().catch(e=>{console.error(e);process.exitCode=1});
