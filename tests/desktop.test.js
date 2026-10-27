const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup(){
  let listener;const sent=[],calls=[],events=[];
  const window={postMessage:m=>sent.push(m),addEventListener:(_,fn)=>listener=fn};
  const location={origin:'https://www.bilibili.com'};
  vm.runInNewContext(fs.readFileSync('content/desktop.js','utf8'),{window,location,setTimeout,clearTimeout,console});
  const api=window.BiliSub.desktop;
  api.mount({getTime:()=>5,isPaused:()=>false,getRate:()=>1,toggle:()=>calls.push('toggle'),seekTo:n=>calls.push(n)},
    {onOpen:()=>events.push('open'),onClose:()=>events.push('close'),onAppearance:m=>events.push(m.fontSize)});
  const receive=payload=>listener({source:window,origin:location.origin,data:{channel:'bili-sub-desktop-response',payload}});
  return {api,sent,calls,events,receive,listener,window};
}
test('native ready 才切模式；字幕时间、命中与关闭恢复事件',async()=>{
  const {api,sent,events,receive}=setup();
  api.setCues([{start:1,end:3,text:'甲'},{start:4,end:6,text:'乙'}]);api.setCurrentTime(5);
  const promise=api.open();assert.deepEqual(events,[]);receive({type:'ready'});await promise;
  assert.deepEqual(events,['open']);const state=sent.at(-1).payload;
  assert.equal(state.index,1);assert.equal(state.cues.length,2);
  api.setCurrentTime(6);assert.equal(sent.at(-1).payload.index,-1);
  receive({type:'closed'});assert.deepEqual(events,['open','close']);
});
test('正文大包按上限裁剪且当前句保留；同句进度不重复发正文',async()=>{
  const {api,sent,receive}=setup();
  api.setCues(Array.from({length:100},(_,i)=>({start:i,end:i+1,text:'长'.repeat(5000)})));
  api.setCurrentTime(50);const promise=api.open();receive({type:'ready'});await promise;
  const state=sent.at(-1).payload;
  assert.ok(Buffer.byteLength(JSON.stringify(state))<1024*1024);
  assert.equal(state.cues[state.index].start,50);
  api.setCurrentTime(50.3);assert.equal(sent.at(-1).payload.cues,undefined);
  api.close();
});
test('来源过滤、命令白名单、连接失败保留页内',async()=>{
  const {api,calls,events,receive,listener,window}=setup();
  const promise=api.open();listener({source:window,origin:'https://example.com',data:{channel:'bili-sub-desktop-response',payload:{type:'ready'}}});
  assert.deepEqual(events,[]);receive({type:'error',message:'助手未安装'});await assert.rejects(promise,/助手未安装/);
  const retry=api.open();receive({type:'ready'});await retry;
  receive({type:'command',action:'execute',value:2});receive({type:'command',action:'seekTo',value:-1});
  receive({type:'command',action:'seekTo',value:12});assert.deepEqual(calls,[12]);api.close();
});

// 真正的四层 JS 串联：MAIN desktop/player → ISOLATED → background → 模拟宿主。
function integratedSetup(){
  const origin='https://www.bilibili.com',worlds=[],nativeStates=[],appearanceEvents=[];
  const signal=()=>{const listeners=[];return {addListener(fn){listeners.push(fn)},emit(value){for(const fn of listeners)fn(value)}};};
  function linkedPorts(){
    const a={onMessage:signal(),onDisconnect:signal(),closed:false},b={onMessage:signal(),onDisconnect:signal(),closed:false};
    for(const [self,other] of [[a,b],[b,a]]){
      self.postMessage=value=>{if(self.closed)throw Error('closed');const copy=structuredClone(value);queueMicrotask(()=>{if(!other.closed)other.onMessage.emit(copy)})};
      self.disconnect=()=>{if(self.closed)return;self.closed=other.closed=true;self.onDisconnect.emit();other.onDisconnect.emit();};
    }
    return [a,b];
  }
  let native;
  const runtime={id:'extension',lastError:null,onConnect:signal(),
    connect(){const [client,background]=linkedPorts();background.name='bili-sub-desktop';background.sender={id:'extension',frameId:0,tab:{id:1},url:origin+'/video/BVtest1/'};queueMicrotask(()=>runtime.onConnect.emit(background));return client;},
    connectNative(){native={onMessage:signal(),onDisconnect:signal(),postMessage:state=>nativeStates.push(structuredClone(state)),disconnect(){this.onDisconnect.emit()}};queueMicrotask(()=>native.onMessage.emit({type:'ready'}));return native;}
  };
  vm.runInNewContext(fs.readFileSync('background-desktop.js','utf8'),{chrome:{runtime},URL,setTimeout,clearTimeout});
  function world(){
    const listeners={};
    const window={addEventListener(type,fn){(listeners[type]??=[]).push(fn)},removeEventListener(){},postMessage(value){
      const copy=structuredClone(value);for(const target of worlds)queueMicrotask(()=>{for(const fn of target.listeners.message||[])fn({source:target.window,origin,data:copy})});
    }};
    const result={window,listeners};worlds.push(result);return result;
  }
  const main=world(),isolated=world();
  vm.runInNewContext(fs.readFileSync('content/desktop-bridge.js','utf8'),{window:isolated.window,top:isolated.window,location:{origin},chrome:{runtime}});
  const video=new EventTarget();Object.assign(video,{currentTime:5,duration:500,readyState:4,playbackRate:1,paused:false,isConnected:true,clientWidth:640});
  video.play=async()=>{video.paused=false;video.dispatchEvent(new Event('play'));};video.pause=()=>{video.paused=true;video.dispatchEvent(new Event('pause'));};
  const document=new EventTarget();document.querySelectorAll=selector=>selector==='video'?[video]:[];
  main.window.__INITIAL_STATE__={videoData:{bvid:'BVtest1',aid:101,cid:201,pages:[{page:1,cid:201}]}};
  const context=vm.createContext({window:main.window,document,location:{origin,href:origin+'/video/BVtest1/'},URL,setTimeout,clearTimeout,console,queueMicrotask,
    MutationObserver:class{observe(){}disconnect(){}},setInterval(){return 1},clearInterval(){}});
  vm.runInContext(fs.readFileSync('content/player.js','utf8'),context);
  vm.runInContext(fs.readFileSync('content/desktop.js','utf8'),context);
  const {desktop,player}=main.window.BiliSub;
  desktop.mount(player,{onAppearance:message=>{appearanceEvents.push(structuredClone(message));const {fontSize,transparency,captionOpacity,theme,layout}=message;const next={};for(const [key,value] of Object.entries({fontSize,transparency,theme,layout}))if(value!==undefined)next[key]=value;desktop.setAppearance(next);}});
  player.onTime(value=>desktop.setCurrentTime(value));
  desktop.setCues([{start:0,end:100,text:'用于同步测试的字幕。'}]);
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  return {desktop,video,nativeStates,appearanceEvents,settle,command:message=>native.onMessage.emit({type:'command',...message}),
    async tick(t){video.currentTime=t;video.dispatchEvent(new Event('timeupdate'));await settle();},
    async close(){desktop.close();await settle();player.destroy();}};
}

test('四层串联：桌面倍速命令调用真实player setter并回显，连续timeupdate保持选择',async()=>{
  const env=integratedSetup();await env.desktop.open();await env.settle();
  try {
    assert.equal(env.nativeStates.at(-1).rate,1);
    for(const rate of [1.5,2,0.75,1]){
      // 同一事件循环内交错旧进度推送与新倍速命令，最终回显必须是新倍速。
      env.video.dispatchEvent(new Event('timeupdate'));
      env.command({action:'setRate',value:rate});
      env.video.dispatchEvent(new Event('timeupdate'));await env.settle();
      assert.equal(env.video.playbackRate,rate);assert.equal(env.nativeStates.at(-1).rate,rate);
      const start=env.nativeStates.length;
      for(let i=0;i<8;i++)await env.tick(6+i/4);
      assert.ok(env.nativeStates.slice(start).length>=8);
      assert.ok(env.nativeStates.slice(start).every(state=>state.rate===rate));
    }
    env.command({action:'setRate',value:99});await env.settle();assert.equal(env.video.playbackRate,1);
  } finally {await env.close();}
});

test('四层串联：排版默认flow，桌面与页内双向同步，非法layout拒绝',async()=>{
  const env=integratedSetup();await env.desktop.open();await env.settle();
  try {
    assert.equal(env.nativeStates.at(-1).layout,'flow');
    env.command({action:'appearance',layout:'lines'});await env.settle();
    assert.equal(env.appearanceEvents.at(-1).layout,'lines');assert.equal(env.nativeStates.at(-1).layout,'lines');
    await env.tick(6);assert.equal(env.nativeStates.at(-1).layout,'lines');
    env.desktop.setAppearance({layout:'flow'});await env.settle();assert.equal(env.nativeStates.at(-1).layout,'flow');
    const before=env.appearanceEvents.length;
    env.command({action:'appearance',layout:'illegal'});await env.settle();
    assert.equal(env.appearanceEvents.length,before);assert.equal(env.nativeStates.at(-1).layout,'flow');
    env.desktop.setAppearance({layout:'illegal'});await env.settle();assert.equal(env.nativeStates.at(-1).layout,'flow');
  } finally {await env.close();}
});
