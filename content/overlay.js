(() => {
  'use strict';
  const ns = window.BiliSub = window.BiliSub || {};
  if (ns.overlay) return;
  // 保留外观偏好；页面仅提供重开入口，字幕只在全局窗口显示。
  const preferenceKey = 'bili-sub:appearance:v3';
  let saved = {};
  try { saved = JSON.parse(window.localStorage?.getItem(preferenceKey) || '{}') || {}; } catch (_) {}
  const defaults = {fontSize:18,transparency:100,captionOpacity:90,step:10,theme:'paper',layout:'flow'};
  const ranges = {fontSize:[12,32],transparency:[0,100],captionOpacity:[0,100],step:[1,120]};
  let appearance = {...defaults}, mounted = false, active = false, pending = false, host, label, button;
  function accept(value) {
    for (const [key,[min,max]] of Object.entries(ranges)) {
      if (typeof value[key] === 'number' && Number.isFinite(value[key])) appearance[key] = Math.min(max,Math.max(min,value[key]));
    }
    if (['paper','night'].includes(value.theme)) appearance.theme=value.theme;
    if (['flow','lines'].includes(value.layout)) appearance.layout=value.layout;
  }
  accept(saved);
  function show(message) { host.hidden=false;label.textContent=message; }
  async function open() {
    if (active || pending) return;
    pending=true;button.disabled=true;show('正在打开全局字幕…');
    try {
      if (!ns.desktop) throw new Error('桌面助手模块未加载，请重新加载扩展并刷新页面。');
      await ns.desktop.open();
    } catch (error) { show(error.message || '无法打开全局字幕，请运行一键安装器后重试。'); }
    finally { pending=false;button.disabled=false; }
  }
  function mount(player) {
    if (mounted) return;
    mounted=true;
    host=document.createElement('div');host.id='bili-sub-launcher';
    const root=host.attachShadow({mode:'open'}),style=document.createElement('style');
    style.textContent=':host{position:fixed;right:16px;bottom:20px;z-index:2147483647;font:13px/1.5 "Microsoft YaHei",sans-serif;color:#24221e}:host([hidden]){display:none}aside{max-width:300px;padding:10px 12px;background:#f7f4ed;border:1px solid #c9c0b1;box-shadow:0 2px 12px #0002}p{margin:0 0 8px;white-space:pre-wrap}button{background:#116a72;color:white;border:0;padding:7px 12px;cursor:pointer;font:inherit}button:disabled{opacity:.6}button:focus-visible{outline:2px solid #116a72;outline-offset:3px}';
    const aside=document.createElement('aside');label=document.createElement('p');label.setAttribute('role','status');
    button=document.createElement('button');button.type='button';button.textContent='打开全局字幕';button.addEventListener('click',open);
    aside.append(label,button);root.append(style,aside);document.body.append(host);
    ns.desktop?.mount(player,{
      onOpen(){active=true;host.hidden=true;},
      onClose(){active=false;show('全局字幕已关闭。');},
      onError(message){show(message);},
      onAppearance(value){accept(value);try {window.localStorage?.setItem(preferenceKey,JSON.stringify(appearance));}catch(_){}ns.desktop.setAppearance(appearance);}
    });
    ns.desktop?.setAppearance(appearance);
    open();
  }
  ns.overlay={mount,open,
    setCues(value){ns.desktop?.setCues(value);},
    setCurrentTime(value){ns.desktop?.setCurrentTime(value);},
    setStatus(value){ns.desktop?.setStatus(value);},
    setCurrentLine(value){ns.desktop?.setCurrentLine(value);},
    setDebug(value){ns.desktop?.setSource(value.source || '');}
  };
})();
