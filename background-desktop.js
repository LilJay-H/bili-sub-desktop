(() => {
  'use strict';
  // Native Messaging 只传字幕和白名单播放命令，不接收文件路径或系统命令。
  let active = null;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  function number(value, min, max) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  }
  function cleanState(value) {
    if (!value || value.type !== 'state') return null;
    const result = { type: 'state' };
    const numeric = { time:[0,1e9], duration:[0,1e9], rate:[0.25,4], step:[1,120], fontSize:[12,32], transparency:[0,100], captionOpacity:[0,100], index:[-1,119] };
    for (const [key, range] of Object.entries(numeric)) {
      if (!own(value, key)) continue;
      if (!number(value[key], ...range) || (key === 'index' && !Number.isInteger(value[key]))) return null;
      result[key] = value[key];
    }
    if (own(value, 'paused')) { if (typeof value.paused !== 'boolean') return null; result.paused = value.paused; }
    if (own(value, 'theme')) { if (!['paper','night'].includes(value.theme)) return null; result.theme = value.theme; }
    if (own(value, 'layout')) { if (!['flow','lines'].includes(value.layout)) return null; result.layout = value.layout; }
    for (const key of ['status','source','videoKey']) {
      if (!own(value, key)) continue;
      if (typeof value[key] !== 'string' || value[key].length > 500) return null;
      result[key] = value[key];
    }
    if (own(value, 'cues')) {
      if (!Array.isArray(value.cues) || value.cues.length > 120) return null;
      let characters = 0;
      result.cues = [];
      for (const cue of value.cues) {
        if (!cue || !number(cue.start,0,1e9) || !number(cue.end,0,1e9) || cue.end <= cue.start ||
            typeof cue.text !== 'string' || cue.text.length > 5000 || (characters += cue.text.length) > 96000) return null;
        result.cues.push({ start:cue.start, end:cue.end, text:cue.text });
      }
      if (result.index >= result.cues.length) return null;
    }
    return result;
  }
  function cleanNative(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.type === 'ready' || value.type === 'closed') return { type:value.type };
    if (value.type !== 'command') return null;
    const action = value.action;
    if (['toggle','prev','next','close'].includes(action)) return { type:'command', action };
    const ranges = { volumeBy:[-1,1], seekBy:[-120,120], seekTo:[0,1e9], setRate:[0.25,4] };
    if (ranges[action]) return number(value.value, ...ranges[action]) ? { type:'command', action, value:value.value } : null;
    if (action !== 'appearance') return null;
    const result = { type:'command', action };
    for (const [key, range] of Object.entries({fontSize:[12,32],transparency:[0,100],captionOpacity:[0,100],step:[1,120]})) {
      if (!own(value,key)) continue;
      if (!number(value[key],...range)) return null;
      result[key] = value[key];
    }
    if (own(value,'theme')) { if (!['paper','night'].includes(value.theme)) return null; result.theme = value.theme; }
    if (own(value,'layout')) { if (!['flow','lines'].includes(value.layout)) return null; result.layout = value.layout; }
    return Object.keys(result).length > 2 ? result : null;
  }
  function allowed(sender) {
    if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab) return false;
    try { const url = new URL(sender.url); return url.origin === 'https://www.bilibili.com'; } catch (_) { return false; }
  }
  chrome.runtime.onConnect.addListener(client => {
    if (client.name !== 'bili-sub-desktop') return;
    const post = value => { try { client.postMessage(value); } catch (_) {} };
    if (!allowed(client.sender)) { post({type:'error',message:'当前页面不能打开桌面字幕。'}); client.disconnect(); return; }
    if (active) { post({type:'error',message:'另一个 B 站页面正在使用桌面字幕，请先关闭那个字幕窗口。'}); client.disconnect(); return; }
    let native, done = false, ready = false, timeout;
    const session = {}; active = session;
    function finish(notify = true) {
      if (done) return;
      done = true; clearTimeout(timeout);
      if (active === session) active = null;
      if (notify) post({type:'closed'});
      try { native?.disconnect(); } catch (_) {}
      try { client.disconnect(); } catch (_) {}
    }
    client.onDisconnect.addListener(() => { void chrome.runtime.lastError; finish(false); });
    client.onMessage.addListener(message => {
      if (done) return;
      if (message?.type === 'close') {
        try { native?.postMessage({type:'close'}); } catch (_) {}
        finish(); return;
      }
      const state = cleanState(message);
      if (!state) { post({type:'error',message:'桌面字幕数据格式不支持，请刷新视频页。'}); finish(); return; }
      try { native.postMessage(state); } catch (_) {
        post({type:'error',message:'桌面字幕连接已断开，请重新打开。'}); finish();
      }
    });
    try {
      native = chrome.runtime.connectNative('com.bilisub.desktop');
      native.onMessage.addListener(value => {
        if (done) return;
        const message = cleanNative(value);
        if (!message) return;
        if (message.type === 'ready') { ready = true; clearTimeout(timeout); }
        post(message);
        if (message.type === 'closed') finish(false);
      });
      native.onDisconnect.addListener(() => {
        // 消费 lastError，但不输出可能包含本机路径的原始错误。
        void chrome.runtime.lastError;
        if (done) return;
        post({type:'error',message:ready ? '桌面字幕组件已退出，请重新打开。' : '尚未连接桌面透明组件。请双击 native/Install.cmd 完成免 ID 安装，再重新打开。'});
        finish();
      });
      timeout = setTimeout(() => {
        if (ready || done) return;
        post({type:'error',message:'桌面透明组件启动超时，请检查本地安装后重试。'}); finish();
      },10000);
    } catch (_) {
      post({type:'error',message:'无法启动桌面透明组件，请先完成本地安装并重新加载扩展。'}); finish();
    }
  });
})();
