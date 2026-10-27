(() => {
  'use strict';
  if (window !== top) return;
  let port = null;
  const reply = payload => window.postMessage({channel:'bili-sub-desktop-response',payload},location.origin);
  function close() {
    const current = port; port = null;
    if (!current) return;
    try { current.postMessage({type:'close'}); current.disconnect(); } catch (_) {}
    reply({type:'closed'});
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== 'bili-sub-desktop-request') return;
    if (message.action === 'close') { close(); return; }
    if (message.action === 'open') {
      if (port) return;
      try {
        const current = chrome.runtime.connect({name:'bili-sub-desktop'}); port = current;
        current.onMessage.addListener(value => { if (port === current) reply(value); });
        current.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (port !== current) return;
          port = null; reply({type:'closed'});
        });
      } catch (_) { reply({type:'error',message:'扩展连接不可用，请重新加载扩展并刷新视频页。'}); }
      return;
    }
    if (message.action !== 'state' || !port || !message.payload || message.payload.type !== 'state') return;
    try { port.postMessage(message.payload); } catch (_) {
      reply({type:'error',message:'桌面字幕连接已断开，请重新打开。'}); close();
    }
  });
  window.addEventListener('pagehide', close);
})();
