// 无依赖的 DOM 替身：检查字幕时序、文本安全和控制接线，不冒充浏览器/PiP 真机测试。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {};
    this.style = { setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } }; this.listeners = {}; this.textContent = ''; this.className = '';
    this.scrollTop = 0; this.clientHeight = 120;
    this.classList = {
      add: value => { this.className = [...new Set([...this.className.split(' '), value])].join(' '); },
      remove: value => { this.className = this.className.split(' ').filter(item => item !== value).join(' '); },
      contains: value => this.className.split(' ').includes(value)
    };
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') { this.append(...node.children); continue; }
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
      this.children.push(node); node.parent = this;
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  attachShadow() { this.shadowRoot = new Element('#shadow'); return this.shadowRoot; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  scrollIntoView() { this.scrolled = true; }
  scrollTo(options) { this.scrolled = options; }
  getClientRects() { return [{top:0,bottom:28}]; }
  getBoundingClientRect() { return {top:0,left:0,width:760,height:192}; }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; }
  matches() { return false; }
  focus() { for (const fn of this.listeners.focus || []) fn({}); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  async dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) await fn(event); }
  get options() { return this.children; }
  async click() { for (const listener of this.listeners.click || []) await listener({ isTrusted: false }); }
}
function setup(saved = '{}', fail = false) {
  const storage = new Map([['bili-sub:appearance:v3',saved]]), calls=[];
  let callbacks, attempts=0;
  const desktop={
    mount(player,cb){callbacks=cb},
    async open(){attempts++;if(fail)throw Error('助手未安装，请运行一键安装器');callbacks.onOpen()},
    setAppearance:v=>calls.push(['appearance',structuredClone(v)]),setCues:v=>calls.push(['cues',v]),
    setCurrentTime:v=>calls.push(['time',v]),setStatus:v=>calls.push(['status',v]),
    setCurrentLine:v=>calls.push(['line',v]),setSource:v=>calls.push(['source',v])
  };
  const document={createElement:tag=>new Element(tag),body:new Element('body')};
  const window={BiliSub:{desktop},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}};
  vm.runInNewContext(fs.readFileSync('content/overlay.js','utf8'),{window,document,console});
  const overlay=window.BiliSub.overlay;overlay.mount({});
  const host=document.body.children[0],aside=host.shadowRoot.children[1],label=aside.children[0],button=aside.children[1];
  return {overlay,host,label,button,calls,storage,document,get attempts(){return attempts},get callbacks(){return callbacks},setFail:value=>fail=value,settle:()=>new Promise(r=>setImmediate(r))};
}

test('默认自动打开全局窗，页面不创建字幕卡；重复mount不重复启动',async()=>{
  const e=setup();await e.settle();
  assert.equal(e.attempts,1);assert.equal(e.host.hidden,true);
  assert.deepEqual(e.document.body.children.map(n=>n.id),['bili-sub-launcher']);
  e.overlay.mount({});assert.equal(e.attempts,1);
});
test('关闭后只留重开入口；用户点击可重开，不自动反复打开',async()=>{
  const e=setup();await e.settle();e.callbacks.onClose();
  assert.equal(e.host.hidden,false);assert.match(e.label.textContent,/已关闭/);assert.equal(e.attempts,1);
  await e.button.click();assert.equal(e.attempts,2);assert.equal(e.host.hidden,true);
});
test('安装失败提示可见，重试成功；关闭后收到错误不丢提示',async()=>{
  const e=setup('{}',true);await e.settle();assert.match(e.label.textContent,/助手未安装/);
  assert.equal(e.button.disabled,false);assert.equal(e.host.hidden,false);
  e.setFail(false);await e.button.click();assert.equal(e.host.hidden,true);
  e.callbacks.onClose();e.callbacks.onError('连接断开');assert.equal(e.label.textContent,'连接断开');
});
test('迁移原外观偏好，原生外观和步长回传持久化',async()=>{
  const e=setup(JSON.stringify({fontSize:22,transparency:88,captionOpacity:95,theme:'night',layout:'lines',step:15,geometry:{width:800}}));await e.settle();
  const before=e.calls.find(c=>c[0]==='appearance')[1];assert.equal(before.step,15);assert.equal(before.fontSize,22);
  e.callbacks.onAppearance({step:20,fontSize:16,layout:'flow'});
  const saved=JSON.parse(e.storage.get('bili-sub:appearance:v3'));assert.equal(saved.step,20);assert.equal(saved.fontSize,16);assert.equal(saved.transparency,88);
  e.callbacks.onAppearance({step:NaN,layout:'illegal'});assert.equal(e.calls.at(-1)[1].step,20);assert.equal(e.calls.at(-1)[1].layout,'flow');
});
test('完整字幕、DOM当前句、状态和时间均转发给桌面助手',async()=>{
  const e=setup();await e.settle();
  const cues=[{start:0,end:1,text:'测试'}];e.overlay.setCues(cues);e.overlay.setCurrentTime(.5);e.overlay.setCurrentLine('DOM句');e.overlay.setDebug({source:'dom'});e.overlay.setStatus('当前句模式');
  assert.deepEqual(e.calls.slice(-5),[['cues',cues],['time',.5],['line','DOM句'],['source','dom'],['status','当前句模式']]);
  assert.equal(e.host.hidden,true);
});
