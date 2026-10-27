'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname,'..',name),'utf8');
const sender = {id:'extension',frameId:0,tab:{id:12},url:'https://www.bilibili.com/video/BVtest/'};
function event() {
  const callbacks=[];
  return {addListener(fn){callbacks.push(fn)},emit(value){for(const fn of callbacks)fn(value)}};
}
function port(extra={}) {
  return {onMessage:event(),onDisconnect:event(),sent:[],disconnected:false,...extra,
    postMessage(value){this.sent.push(structuredClone(value))},
    disconnect(){if(this.disconnected)return;this.disconnected=true;this.onDisconnect.emit()}
  };
}
function background() {
  const connections=[],timers=new Map(); let sequence=0;
  const runtime={id:'extension',onConnect:event(),lastError:null,connectNative(name){const p=port();connections.push({name,p});return p}};
  vm.runInNewContext(source('background-desktop.js'),{chrome:{runtime},URL,
    setTimeout(fn){const id=++sequence;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)}
  });
  return {runtime,connections,timers,open(overrides={}){const p=port({name:'bili-sub-desktop',sender:{...sender,...overrides}});runtime.onConnect.emit(p);return p}};
}
function browserBridge() {
  const listeners={},outbound=[],connections=[];
  const window={addEventListener(type,fn){listeners[type]=fn},postMessage(value,origin){outbound.push({value:structuredClone(value),origin})}};
  const runtime={lastError:null,connect(options){const p=port();connections.push({options,p});return p}};
  vm.runInNewContext(source('content/desktop-bridge.js'),{window,top:window,location:{origin:'https://www.bilibili.com'},chrome:{runtime}});
  return {connections,outbound,window,listeners,send(action,payload,overrides={}){listeners.message({source:window,origin:'https://www.bilibili.com',data:{channel:'bili-sub-desktop-request',action,payload},...overrides})}};
}
test('native bridge 拒绝其他来源和第二个活动页面，不增加宿主进程',()=>{
  const env=background();
  for(const bad of [{id:'other'},{frameId:1},{tab:null},{url:'https://www.bilibili.com.evil.test/'},{url:'http://www.bilibili.com/'}]) {
    const client=env.open(bad);assert.equal(client.disconnected,true);assert.equal(client.sent[0].type,'error');
  }
  assert.equal(env.connections.length,0);
  const client=env.open();assert.equal(env.connections[0].name,'com.bilisub.desktop');
  const second=env.open();assert.equal(second.disconnected,true);assert.equal(env.connections.length,1);
  client.disconnect();env.open();assert.equal(env.connections.length,2);
});
test('native bridge state 只保留字幕和播放字段，限制长度/数值/索引',()=>{
  const env=background(),client=env.open(),native=env.connections[0].p;
  const good={type:'state',time:7,paused:false,rate:1,step:10,fontSize:18,transparency:95,captionOpacity:90,theme:'paper',layout:'flow',source:'api',status:'已载入',index:0,cues:[{start:1,end:9,text:'字幕',path:'unexpected'}],execute:'not allowed'};
  client.onMessage.emit(good);
  const sent=native.sent[0];assert.equal(sent.execute,undefined);assert.equal(sent.cues[0].path,undefined);assert.equal(sent.cues[0].text,'字幕');assert.equal(sent.layout,'flow');assert.equal(sent.captionOpacity,90);
  const invalid=[{...good,time:NaN},{...good,index:1},{...good,cues:[{start:1,end:0,text:'错'}]},
    {...good,cues:[{start:1,end:9,text:'长'.repeat(5001)}]},{...good,cues:Array(121).fill(good.cues[0])},
    {...good,theme:'url(path)'},{...good,layout:'invalid'},{...good,fontSize:400},{...good,captionOpacity:101},{type:'execute',command:'not allowed'}];
  client.onMessage.emit({type:'state',time:8,index:0});assert.equal(native.sent.length,2);
  client.disconnect();
  for(const value of invalid) {
    const next=env.open(),nextNative=env.connections.at(-1).p;
    next.onMessage.emit(value);
    assert.equal(nextNative.sent.length,0);assert.equal(next.sent[0].type,'error');
    assert.equal(next.sent.at(-1).type,'closed');assert.equal(next.disconnected,true);assert.equal(nextNative.disconnected,true);
  }
});
test('native bridge 宿主命令白名单、ready 握手和双向关闭',()=>{
  const env=background(),client=env.open(),native=env.connections[0].p;
  native.onMessage.emit({type:'ready',extra:'discard'});assert.equal(env.timers.size,0);assert.deepEqual(client.sent[0],{type:'ready'});
  native.onMessage.emit({type:'command',action:'execute',value:'not allowed'});
  native.onMessage.emit({type:'command',action:'seekTo',value:-1});
  native.onMessage.emit({type:'command',action:'appearance',theme:'invalid'});
  native.onMessage.emit({type:'command',action:'appearance',layout:'invalid'});
  assert.equal(client.sent.length,1);
  native.onMessage.emit({type:'command',action:'seekBy',value:-10,extra:'discard'});
  native.onMessage.emit({type:'command',action:'appearance',fontSize:14,transparency:100,captionOpacity:85,theme:'night'});
  assert.deepEqual(client.sent[1],{type:'command',action:'seekBy',value:-10});
  assert.equal(client.sent[2].fontSize,14);assert.equal(client.sent[2].captionOpacity,85);
  native.onMessage.emit({type:'command',action:'appearance',layout:'lines'});
  assert.deepEqual(client.sent[3],{type:'command',action:'appearance',layout:'lines'});
  client.onMessage.emit({type:'state',layout:'lines'});assert.equal(native.sent[0].layout,'lines');
  client.onMessage.emit({type:'close'});assert.deepEqual(native.sent[1],{type:'close'});
  assert.equal(native.disconnected,true);assert.equal(client.disconnected,true);assert.equal(client.sent.at(-1).type,'closed');
});
test('native bridge 未安装、启动超时不泄漏底层路径且允许重开',()=>{
  const env=background(),client=env.open();
  env.runtime.lastError={message:'sensitive local path, never forward'};
  env.connections[0].p.disconnect();
  assert.equal(client.sent[0].type,'error');assert.match(client.sent[0].message,/Install/);
  assert.ok(!JSON.stringify(client.sent).includes('sensitive'));
  const next=env.open();for(const fn of [...env.timers.values()])fn();
  assert.equal(next.disconnected,true);assert.match(next.sent[0].message,/超时/);
});
test('页面桥只转发同页消息，open前不转发状态，pagehide关闭',()=>{
  const env=browserBridge();
  env.send('open',null,{source:{}});env.send('open',null,{origin:'https://other.test'});
  env.send('state',{type:'state',time:1});assert.equal(env.connections.length,0);
  env.send('open');env.send('open');assert.equal(env.connections.length,1);
  const native=env.connections[0].p;
  env.send('state',{type:'state',time:1});assert.deepEqual(native.sent[0],{type:'state',time:1});
  native.onMessage.emit({type:'ready'});assert.deepEqual(env.outbound[0],{origin:'https://www.bilibili.com',value:{channel:'bili-sub-desktop-response',payload:{type:'ready'}}});
  env.listeners.pagehide();assert.equal(native.disconnected,true);assert.equal(native.sent.at(-1).type,'close');
  env.send('state',{type:'state',time:2});assert.equal(native.sent.length,2);
});
test('页面桥断线可以重新打开，旧连接消息不影响新连接',()=>{
  const env=browserBridge();env.send('open');const old=env.connections[0].p;
  old.disconnect();env.send('open');const current=env.connections[1].p;
  old.onMessage.emit({type:'ready'});assert.equal(env.outbound.length,1);
  current.onMessage.emit({type:'ready'});assert.equal(env.outbound.at(-1).value.payload.type,'ready');
  env.send('close');assert.equal(current.disconnected,true);
});
