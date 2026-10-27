(() => {
  'use strict';
  const ns = window.BiliSub = window.BiliSub || {};
  if (ns.overlay) return;

  let player, host, root, launcher, childWindow;
  let mode = 'inline', cues = [], rows = [], currentIndex = -1, lastAnchor = -1;
  let time = 0, step = 10, source = '等待', lang = '', domLine = '';
  let status = '正在寻找视频字幕…', fontSize = 22, opacity = 94;
  const ui = {};

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function log(event, details = {}) {
    console.info('[bili-sub]', event, details);
  }
  function safeCall(fn) {
    return async () => {
      try { await fn(); updateControls(); }
      catch (error) { setStatus(typeof error?.message === 'string' ? error.message : '操作未成功，请回到视频页检查播放器。'); }
    };
  }
  function button(text, title, handler, className = '') {
    const node = el('button', className, text);
    node.type = 'button'; node.title = title; node.setAttribute('aria-label', title);
    node.addEventListener('click', safeCall(handler));
    return node;
  }
  function formatTime(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function updateControls() {
    if (!root) return;
    let paused = true;
    try { paused = player.isPaused(); } catch (_) { /* 视频切换期间保留按钮 */ }
    ui.play.textContent = paused ? '播放' : '暂停';
    ui.play.setAttribute('aria-label', paused ? '播放视频' : '暂停视频');
    try {
      const rate = String(player.getRate());
      if ([...ui.rate.options].some(option => option.value === rate)) ui.rate.value = rate;
    } catch (_) { /* 元数据尚未就绪 */ }
    ui.clock.textContent = formatTime(time);
    ui.debug.textContent = `来源 ${source}${lang ? ' · ' + lang : ''}  |  字幕 ${cues.length} 条\n时间 ${time.toFixed(1)} s  |  命中 ${currentIndex >= 0 ? currentIndex : '—'}（从 0 开始）\n窗口 ${mode === 'pip' ? 'Document PiP · 浏览器置顶窗' : mode === 'popup' ? '普通小窗 · 不保证置顶' : '页内 · 不跨应用置顶'}`;
  }
  function updateAppearance() {
    host.style.setProperty('--bili-sub-font', `${fontSize}px`);
    host.style.setProperty('--bili-sub-bg', `rgba(17,22,33,${opacity / 100})`);
    ui.fontValue.textContent = `${fontSize}px`;
    ui.opacityValue.textContent = `${opacity}%`;
  }
  function restoreInline() {
    childWindow = null; mode = 'inline';
    if (!host || !document.body) return;
    document.body.append(document.adoptNode(host));
    host.dataset.mode = 'inline'; host.hidden = false;
    ui.mode.textContent = '页内歌词卡';
    launcher.hidden = false;
    updateControls();
    log('overlay-window', { mode });
  }
  function moveIntoWindow(win, newMode) {
    childWindow = win; mode = newMode;
    win.document.title = 'B 站字幕 · 桌面歌词';
    win.document.documentElement.style.cssText = 'height:100%;background:#111621;color-scheme:dark';
    win.document.body.style.cssText = 'height:100%;margin:0;overflow:hidden';
    win.document.body.replaceChildren(win.document.adoptNode(host));
    host.dataset.mode = newMode; host.hidden = false;
    ui.mode.textContent = newMode === 'pip' ? '桌面置顶歌词' : '普通小窗 · 不置顶';
    win.addEventListener('pagehide', () => {
      if (childWindow === win) restoreInline();
    }, { once: true });
    updateControls();
    if (currentIndex >= 0) rows[currentIndex]?.scrollIntoView({ block: 'center' });
    log('overlay-window', { mode });
  }
  async function openPiP() {
    if (childWindow && !childWindow.closed) { childWindow.focus(); return; }
    if (!window.documentPictureInPicture?.requestWindow) {
      setStatus('当前浏览器不支持桌面置顶窗。请使用较新的 Chrome / Edge，或点击「普通小窗」（不置顶）。');
      host.hidden = false; return;
    }
    try {
      // 必须直接由用户点击触发，调用前不做异步请求。
      const win = await window.documentPictureInPicture.requestWindow({ width: 440, height: 600 });
      moveIntoWindow(win, 'pip');
    } catch (error) {
      host.hidden = false;
      setStatus(error?.name === 'NotAllowedError'
        ? '请亲自点击「桌面置顶」。浏览器要求一次真实点击；也可使用「普通小窗」。'
        : '置顶窗未能打开，请再次点击「桌面置顶」，或使用「普通小窗」（不置顶）。');
      log('overlay-pip-unavailable', { reason: error?.name || 'unknown' });
    }
  }
  function openPopup() {
    if (childWindow && !childWindow.closed) { childWindow.focus(); return; }
    const win = window.open('', 'bili-sub-lyrics', 'popup,width=440,height=600');
    if (!win) { setStatus('普通小窗被浏览器拦截。请使用页内歌词卡，或手动允许这次弹出窗口。'); return; }
    moveIntoWindow(win, 'popup');
  }
  function closeOrHide() {
    if (childWindow && !childWindow.closed) { childWindow.close(); restoreInline(); }
    else host.hidden = true;
  }
  function mount(playerApi) {
    player = playerApi;
    if (host) return;
    if (!document.body) throw new Error('视频页还没有准备好，请稍后重试。');
    host = el('div'); host.id = 'bili-sub-overlay'; host.dataset.mode = 'inline';
    // Shadow DOM 防止 B 站页面样式影响字幕卡，整张卡可移动到 PiP 文档。
    root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = `
      :host{all:initial;display:block;color:#edf1fa;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;--bili-sub-font:22px;--bili-sub-bg:rgba(17,22,33,.94)}
      :host([hidden]){display:none!important}
      :host([data-mode="inline"]){position:fixed;z-index:2147483646;right:22px;bottom:76px;width:min(420px,calc(100vw - 32px));height:min(580px,calc(100vh - 100px));filter:drop-shadow(0 18px 40px #0007)}
      :host([data-mode="pip"]),:host([data-mode="popup"]){width:100%;height:100%}
      *{box-sizing:border-box}button,select,input{font:inherit}button,select{color:inherit;background:#ffffff0b;border:1px solid #ffffff14;border-radius:9px;cursor:pointer}button{padding:8px 11px}button:hover,select:hover{background:#ffffff20}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #8be8c7;outline-offset:2px}
      .card{display:flex;flex-direction:column;height:100%;background:var(--bili-sub-bg);border:1px solid #ffffff1c;border-radius:17px;overflow:hidden}
      :host([data-mode="pip"]) .card,:host([data-mode="popup"]) .card{border-radius:0}
      .header{display:flex;align-items:center;gap:10px;padding:16px 17px 10px}.brand{width:31px;height:31px;display:grid;place-items:center;background:#8be8c717;color:#8be8c7;border-radius:10px;font-weight:800}.heading{flex:1}.title{font-size:14px;font-weight:700;letter-spacing:.4px}.mode{font-size:11px;color:#8c9bae;margin-top:3px}.close{border:0;background:none;font-size:20px;padding:2px 9px}.status{font-size:12px;line-height:1.6;color:#b8c9df;padding:0 18px 8px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:90px;overflow:auto}.status:empty{display:none}
      .lyrics{flex:1;min-height:90px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#63748a40 transparent;padding:16px 18px 40px;scroll-behavior:smooth}.line{display:block;width:100%;text-align:left;line-height:1.65;font-size:var(--bili-sub-font);font-weight:500;border:0;background:none;color:#8895a8;padding:11px 6px;white-space:pre-wrap;overflow-wrap:anywhere;transition:color .15s,background .15s}.line:hover{background:#ffffff09}.line.active{color:#a8f4d8;background:#8be8c70a;font-weight:700}.empty{color:#8c9bae;font-size:16px;line-height:1.8;margin-top:20px;white-space:pre-wrap}.domline{color:#a8f4d8;font-size:var(--bili-sub-font);line-height:1.7;white-space:pre-wrap}
      .footer{padding:11px 15px 13px;border-top:1px solid #ffffff0d;background:#080c121a}.timeline{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:11px;color:#8295ae;font-variant-numeric:tabular-nums}.controls{display:flex;gap:6px;justify-content:space-between;align-items:center}.controls button{font-size:13px;padding:8px 9px;white-space:nowrap}.controls .play{background:#a8f4d8;color:#142820;border-color:#a8f4d8;min-width:65px;font-weight:700}.rate{padding:7px 5px;font-size:12px;max-width:75px}.rate option{background:#17202c}.windows{display:flex;gap:7px;margin-top:10px}.windows button{flex:1;font-size:11px;color:#b6c9df;padding:6px}.settings{margin-top:11px;font-size:11px;color:#9aabc1}summary{cursor:pointer;user-select:none}.settings-grid{display:grid;grid-template-columns:50px 1fr 45px;gap:9px;align-items:center;margin-top:12px}.settings input[type=range]{width:100%;accent-color:#a8f4d8}.step{width:100%;background:#ffffff0b;color:#edf1fa;border:1px solid #ffffff24;border-radius:5px;padding:5px}.debug{white-space:pre-wrap;font-size:10px;line-height:1.8;color:#8295ae;margin:12px 0 0}.hint{font-size:10px;color:#8295ae;line-height:1.6;margin-top:9px}
      @media(max-width:350px){.header{padding:10px}.footer{padding:9px}.controls{gap:3px}.controls button{font-size:11px;padding:7px 5px}.line{font-size:calc(var(--bili-sub-font) - 2px)}}
      @media(prefers-reduced-motion:reduce){.lyrics{scroll-behavior:auto}.line{transition:none}}
    `;
    root.append(style);
    const card = el('section', 'card'); card.setAttribute('aria-label', 'B 站字幕歌词卡');
    const header = el('header', 'header'), heading = el('div', 'heading');
    heading.append(el('div', 'title', 'B 站字幕'));
    ui.mode = el('div', 'mode', '页内歌词卡'); heading.append(ui.mode);
    header.append(el('div', 'brand', '字'), heading, button('×', '关闭小窗或收起页内卡片', closeOrHide, 'close'));
    ui.status = el('div', 'status', status); ui.status.setAttribute('role', 'status');
    ui.lyrics = el('div', 'lyrics'); ui.lyrics.setAttribute('aria-label', '字幕列表，点击一句跳转');
    const footer = el('footer', 'footer'), timeline = el('div', 'timeline');
    ui.clock = el('span', '', '0:00'); timeline.append(el('span', '', '点击字幕，回到那一刻'), ui.clock);
    const controls = el('div', 'controls');
    ui.play = button('播放', '播放或暂停', () => player.toggle(), 'play');
    ui.back = button('−10s', '快退', () => player.seekBy(-step));
    ui.forward = button('+10s', '快进', () => player.seekBy(step));
    ui.rate = el('select', 'rate'); ui.rate.setAttribute('aria-label', '播放倍速');
    [0.5,0.75,1,1.25,1.5,1.75,2,2.5,3].forEach(rate => {
      const option = el('option', '', `${rate}×`); option.value = String(rate); ui.rate.append(option);
    });
    ui.rate.value = '1'; ui.rate.addEventListener('change', safeCall(() => player.setRate(Number(ui.rate.value))));
    controls.append(button('上一集', '上一集或上一分P', () => player.prev()), ui.back, ui.play, ui.forward,
      button('下一集', '下一集或下一分P', () => player.next()), ui.rate);
    const windows = el('div', 'windows');
    windows.append(button('桌面置顶 ↗', '打开 Document Picture-in-Picture 置顶窗口', openPiP), button('普通小窗', '打开普通小窗，不保证置顶', openPopup));
    const settings = el('details', 'settings'); settings.append(el('summary', '', '外观、快进设置与调试'));
    const grid = el('div', 'settings-grid');
    const font = el('input'); font.type = 'range'; font.min = '14'; font.max = '36'; font.value = String(fontSize); font.setAttribute('aria-label', '字幕字号');
    ui.fontValue = el('span', '', '22px');
    font.addEventListener('input', () => { fontSize = Number(font.value); updateAppearance(); });
    const alpha = el('input'); alpha.type = 'range'; alpha.min = '35'; alpha.max = '100'; alpha.value = String(opacity); alpha.setAttribute('aria-label', '卡片背景不透明度');
    ui.opacityValue = el('span', '', '94%');
    alpha.addEventListener('input', () => { opacity = Number(alpha.value); updateAppearance(); });
    const skip = el('input', 'step'); skip.type = 'number'; skip.min = '1'; skip.max = '120'; skip.value = String(step); skip.setAttribute('aria-label', '快进快退秒数');
    skip.addEventListener('change', () => {
      step = Math.max(1, Math.min(120, Math.round(Number(skip.value) || 10))); skip.value = String(step);
      ui.back.textContent = `−${step}s`; ui.forward.textContent = `+${step}s`;
    });
    grid.append(el('span', '', '字号'), font, ui.fontValue, el('span', '', '背景'), alpha, ui.opacityValue, el('span', '', '快进退'), skip, el('span', '', '秒'));
    ui.debug = el('pre', 'debug');
    settings.append(grid, ui.debug, el('div', 'hint', '关闭小窗会回到页内；刷新视频页后需重新点击置顶。背景滑块只改变卡片底色，浏览器不支持窗口穿透或桌面透明。'));
    footer.append(timeline, controls, windows, settings); card.append(header, ui.status, ui.lyrics, footer); root.append(card);
    launcher = el('div'); launcher.id = 'bili-sub-launcher';
    launcher.style.cssText = 'position:fixed;right:22px;bottom:22px;z-index:2147483647;display:flex;gap:6px;font:13px system-ui;color:#e8fff6';
    const launch = button('字幕置顶 ↗', '打开字幕桌面置顶窗口', openPiP);
    const show = button('歌词卡', '显示或收起页内歌词卡', () => { if (childWindow && !childWindow.closed) childWindow.focus(); else host.hidden = !host.hidden; });
    for (const item of [launch, show]) item.style.cssText = 'background:#17272b;color:#c4ffe7;border:1px solid #65aa9355;border-radius:10px;padding:10px 13px;cursor:pointer;font:13px system-ui;box-shadow:0 4px 18px #0003';
    launcher.append(launch, show); document.body.append(host, launcher);
    window.addEventListener('pagehide', () => { if (childWindow && !childWindow.closed) childWindow.close(); });
    updateAppearance(); renderCues(); updateControls(); log('overlay-mounted');
  }
  function renderCues() {
    if (!ui.lyrics) return;
    ui.lyrics.replaceChildren(); rows = [];
    if (!cues.length) {
      ui.empty = el('div', domLine ? 'domline' : 'empty', domLine || '字幕准备好后会显示在这里。\n支持点击字幕跳转和桌面置顶。');
      ui.lyrics.append(ui.empty); return;
    }
    const fragment = document.createDocumentFragment();
    cues.forEach((cue, index) => {
      const row = button(cue.text, `${formatTime(cue.start)}，点击跳转`, () => player.seekTo(cue.start), 'line');
      row.dataset.index = String(index); rows.push(row); fragment.append(row);
    });
    ui.lyrics.append(fragment);
  }
  function setCues(nextCues) {
    cues = Array.isArray(nextCues) ? nextCues.filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
      .map(cue => ({ start: cue.start, end: cue.end, text: String(cue.text ?? '') })).sort((a,b) => a.start - b.start) : [];
    currentIndex = -1; lastAnchor = -1; domLine = ''; renderCues(); setCurrentTime(time);
    log('overlay-cues', { count: cues.length });
  }
  function setCurrentTime(nextTime) {
    time = Number.isFinite(nextTime) ? Math.max(0, nextTime) : 0;
    let low = 0, high = cues.length - 1, anchor = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].start <= time) { anchor = mid; low = mid + 1; } else high = mid - 1;
    }
    const index = anchor >= 0 && time < cues[anchor].end ? anchor : -1;
    if (index !== currentIndex) {
      rows[currentIndex]?.classList.remove('active'); rows[currentIndex]?.removeAttribute('aria-current');
      currentIndex = index;
      rows[index]?.classList.add('active'); rows[index]?.setAttribute('aria-current', 'true');
    }
    if (anchor !== lastAnchor) {
      lastAnchor = anchor;
      if (anchor >= 0) rows[anchor]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    updateControls();
  }
  function setStatus(message) {
    status = String(message || '');
    if (ui.status) ui.status.textContent = status;
  }
  function setDebug(info = {}) {
    if (info.source !== undefined) source = String(info.source);
    if (info.lang !== undefined) lang = String(info.lang);
    updateControls();
  }
  function setCurrentLine(text) {
    domLine = String(text || '');
    if (!cues.length && ui.empty) {
      ui.empty.className = domLine ? 'domline' : 'empty';
      ui.empty.textContent = domLine || '等待下一句字幕…';
    }
  }
  ns.overlay = { mount, setCues, setCurrentTime, setStatus, setDebug, setCurrentLine };
})();
