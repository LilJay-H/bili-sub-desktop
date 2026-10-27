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
function setup(saved = '{}', desktop) {
  const storage = new Map([['bili-sub:appearance:v3', saved]]);
  const document = { createElement: tag => new Element(tag), createElementNS: (_,tag) => new Element(tag), createTextNode:text=>Object.assign(new Element('#text'),{textContent:text}), createDocumentFragment: () => new Element('#fragment'), body: new Element('body'), adoptNode: node => node };
  const window = { innerWidth:1280, innerHeight:720, addEventListener() {}, localStorage: {getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)} };
  if (desktop) window.BiliSub = {desktop};
  const context = vm.createContext({ document, window, console: { info() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/overlay-style.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/overlay.js'), 'utf8'), context);
  const calls = [];
  const player = { isPaused: () => true, getRate: () => 1, toggle: () => calls.push(['toggle']), seekBy: t => calls.push(['seekBy', t]), seekTo: t => calls.push(['seekTo', t]), setRate: t => calls.push(['setRate', t]), prev: () => { throw Error('已经是第一集'); }, next: () => calls.push(['next']) };
  const overlay = window.BiliSub.overlay;
  overlay.mount(player);
  const host = document.body.children.find(node => node.id === 'bili-sub-overlay');
  function all(node = host.shadowRoot) { return [node, ...node.children.flatMap(child => all(child))]; }
  return { overlay, calls, all, host, storage, window, document };
}
test('半开时间区间高亮；字幕空隙清除高亮；排序并丢弃无效条目', () => {
  const { overlay, all } = setup();
  overlay.setCues([{start:4,end:6,text:'第二句'},{start:0,end:2,text:'第一句'},{start:8,end:7,text:'无效'}]);
  const lines = all().filter(node => node.classList.contains('line'));
  assert.deepEqual(lines.map(node => node.textContent), ['第一句','第二句']);
  overlay.setCurrentTime(1.5); assert.equal(lines[0].classList.contains('active'), true);
  overlay.setCurrentTime(2); assert.equal(lines.some(node => node.classList.contains('active')), false);
  overlay.setCurrentTime(4); assert.equal(lines[1].classList.contains('active'), true);
  overlay.setCurrentTime(1); assert.equal(lines[0].attributes['aria-current'], 'true');
});
test('字幕仅作为文本显示，点击使用该句的开始时间', async () => {
  const { overlay, calls, all } = setup();
  const text = '<img src=x onerror=alert(1)>';
  overlay.setCues([{start:3.2,end:4,text}]);
  const line = all().find(node => node.classList.contains('line'));
  assert.equal(line.textContent, text); assert.equal(line.children.length, 0);
  await line.click(); assert.deepEqual(calls, [['seekTo',3.2]]);
});
test('播放、快进退和下一集接线，上一集错误可见', async () => {
  const { calls, all } = setup();
  for (const name of ['播放视频','快退','快进','下一集或下一分P','上一集或上一分P']) await all().find(node => node.tagName === 'button' && node.attributes['aria-label'] === name).click();
  assert.deepEqual(calls, [['toggle'], ['seekBy',-10], ['seekBy',10], ['next']]);
  assert.equal(all().find(node => node.className === 'status').textContent, '已经是第一集');
});
test('DOM 降级当前句和桌面助手未加载提示', async () => {
  const { overlay, all } = setup();
  overlay.setCues([]); overlay.setCurrentLine('只有当前句');
  assert.equal(all().find(node => node.className === 'domline').textContent, '只有当前句');
  await all().find(node => node.attributes['aria-label'] === '桌面置顶').click();
  assert.match(all().find(node => node.className === 'status').textContent, /桌面助手模块未加载/);
});

test('默认隐藏控制；鼠标离开关闭设置；键盘可展开和退出', async () => {
  const {host, all, document} = setup();
  assert.equal(host.dataset.revealed, 'false');
  assert.equal(document.body.children.find(n=>n.id==='bili-sub-launcher').hidden, true);
  await host.dispatch('pointerenter');
  assert.equal(host.dataset.revealed, 'true');
  await all().find(n=>n.attributes['aria-label']==='外观设置').click();
  assert.equal(host.dataset.settings, 'true');
  await host.dispatch('pointerdown');
  await host.dispatch('pointerleave');
  assert.equal(host.dataset.revealed, 'false');
  assert.equal(host.dataset.settings, 'false');
  await host.dispatch('keydown', {key:'Tab'});
  assert.equal(host.dataset.revealed, 'true');
  await host.dispatch('keydown', {key:'Escape'});
  assert.equal(host.dataset.revealed, 'false');
});

test('窗口全透、字幕底色90%独立控制并保存偏好', async () => {
  const {host,all,storage} = setup();
  const alpha=all().find(n=>n.attributes['aria-label']==='窗口透明度');
  assert.equal(alpha.value, '100'); assert.equal(host.style['--surface-alpha'], '0');
  const backing=all().find(n=>n.attributes['aria-label']==='字幕底色不透明度');assert.equal(backing.value,'90');backing.value='85';await backing.dispatch('input');assert.equal(host.style['--caption-alpha'],'0.85');
  assert.equal(host.style['--subtitle-size'], '18px');
  alpha.value='100'; await alpha.dispatch('input');
  assert.equal(host.style['--surface-alpha'], '0');
  const saved=storage.get('bili-sub:appearance:v3');
  assert.equal(JSON.parse(saved).transparency,100);assert.equal(JSON.parse(saved).captionOpacity,85);
  assert.equal(setup(saved).host.style['--surface-alpha'],'0');
});

test('桌面置顶使用助手，不静默回退不透明 PiP', async () => {
  const {window,all,document,host}=setup();
  window.BiliSub.desktop={open:async()=>{},close:()=>{}};
  // 生命周期在真实 desktop 模块测试；此处验证未安装不静默回退 PiP。
  let pipCalled=false;
  window.documentPictureInPicture={requestWindow:()=>{pipCalled=true;}};
  await all().find(n=>n.attributes['aria-label']==='桌面置顶').click();
  assert.equal(pipCalled,false);
  assert.equal(host.style.width,'760px');
  assert.equal(document.body.children.includes(host),true);
});

test('桌面ready后隐藏页内、返回恢复几何，外观回传保存',async()=>{
  let handlers;const desktop={mount(_,h){handlers=h},setAppearance(){},open:async()=>handlers.onOpen(),close:()=>handlers.onClose()};
  const {host,all,storage,document}=setup('{}',desktop);
  await all().find(n=>n.attributes['aria-label']==='桌面置顶').click();
  assert.equal(host.hidden,true);assert.equal(host.dataset.mode,'desktop');
  handlers.onAppearance({fontSize:22,transparency:98,captionOpacity:92,theme:'night',layout:'lines'});
  assert.equal(JSON.parse(storage.get('bili-sub:appearance:v3')).fontSize,22);
  const launcher=document.body.children.find(n=>n.id==='bili-sub-launcher');await launcher.children[0].click();
  assert.equal(host.hidden,false);assert.equal(host.dataset.mode,'inline');assert.equal(host.style.width,'760px');
  assert.equal(host.style['--subtitle-size'],'22px');assert.equal(host.style['--caption-alpha'],'0.92');assert.equal(host.dataset.layout,'lines');assert.equal(JSON.parse(storage.get('bili-sub:appearance:v3')).layout,'lines');
});

test('拖动和缩放边界限制、持久化；普通小窗入口已移除',async()=>{
  const {host,all,storage}=setup();
  assert.equal(all().some(n=>/普通小窗/.test(n.attributes['aria-label']||'')),false);
  const drag=all().find(n=>n.className==='drag-handle');
  await drag.dispatch('pointerdown',{button:0,clientX:500,clientY:510,pointerId:1,preventDefault(){}});
  await host.dispatch('pointermove',{clientX:300,clientY:300,pointerId:1});
  await host.dispatch('pointerup',{pointerId:1});
  assert.equal(host.style.left,'296px');assert.equal(host.style.top,'294px');
  const edge=all().find(n=>n.dataset.direction==='se');
  await edge.dispatch('pointerdown',{button:0,clientX:1056,clientY:486,pointerId:2,preventDefault(){}});
  await host.dispatch('pointermove',{clientX:1156,clientY:546,pointerId:2});
  await host.dispatch('pointerup',{pointerId:2});
  assert.equal(host.style.width,'860px');assert.equal(host.style.height,'252px');
  assert.equal(setup(storage.get('bili-sub:appearance:v3')).host.style.width,'860px');
  await drag.dispatch('keydown',{key:'ArrowLeft',shiftKey:true,preventDefault(){}});
  assert.equal(host.style.left,'276px');
});

test('手动浏览暂停跟随；点击恢复或切视频后恢复；长字幕保留全文',async()=>{
  const {overlay,all}=setup();const text='很长的一句字幕，'.repeat(100);
  overlay.setCues([{start:0,end:2,text},{start:3,end:4,text:'下一句'}]);
  const line=all().find(n=>n.classList.contains('line'));
  assert.equal(line.tagName,'span');assert.equal(line.textContent,text);
  const lyrics=all().find(n=>n.className==='lyrics');
  await lyrics.dispatch('wheel');const old=lyrics.scrolled;
  overlay.setCurrentTime(3);assert.equal(lyrics.scrolled,old);
  const follow=all().find(n=>n.attributes['aria-label']==='恢复自动跟随当前字幕');
  assert.equal(follow.hidden,false);await follow.click();assert.equal(follow.hidden,true);
});
