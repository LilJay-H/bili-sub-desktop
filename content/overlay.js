(() => {
  'use strict';
  const ns = window.BiliSub = window.BiliSub || {};
  if (ns.overlay) return;
  // 仅保存本工具的外观偏好，不读取网站其他本地数据。
  const preferenceKey = 'bili-sub:appearance:v3';
  let saved = {};
  try { saved = JSON.parse(window.localStorage?.getItem(preferenceKey) || '{}') || {}; } catch (_) {}
  const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
  let fontSize = clamp(saved.fontSize, 12, 32, 18), transparency = clamp(saved.transparency, 0, 100, 100), step = clamp(saved.step, 1, 120, 10);
  let captionOpacity = clamp(saved.captionOpacity, 0, 100, 90);
  let theme = saved.theme === 'night' ? 'night' : 'paper', layout = saved.layout === 'lines' ? 'lines' : 'flow';
  let geometry = saved.geometry || null, gesture = null, following = true;
  let player, host, root, launcher;
  let mode = 'inline', cues = [], rows = [], currentIndex = -1, lastAnchor = -1;
  let time = 0, source = '等待', lang = '', domLine = '', status = '正在读取字幕…';
  const ui = {};
  const paths = {
    play: ['m9 5 10 7-10 7Z'], pause: ['M9 5v14M15 5v14'],
    prev: ['M5 5v14', 'm18 5-10 7 10 7Z'], next: ['M19 5v14', 'm6 5 10 7-10 7Z'],
    pip: ['M9 19H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4', 'M12 12h9v8h-9Z'],
    move: ['M12 3v18M3 12h18m-12-6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3m12-6 3 3-3 3'],
    settings: ['M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6'],
    close: ['m6 6 12 12M18 6 6 18'], back: ['m12 5-7 7 7 7M5 12h14']
  };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key, value);
    for (const d of paths[name] || []) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }
  function log(event, details = {}) { console.info('[bili-sub]', event, details); }
  function savePreferences() {
    try { window.localStorage?.setItem(preferenceKey, JSON.stringify({ fontSize, transparency, captionOpacity, step, theme, layout, geometry })); } catch (_) {}
  }
  function applyGeometry(value = geometry) {
    if (mode !== 'inline') return;
    const widthLimit = Math.max(100, window.innerWidth - 16), heightLimit = Math.max(80, window.innerHeight - 16);
    const width = clamp(value?.width, Math.min(340, widthLimit), widthLimit, Math.min(760, widthLimit));
    const height = clamp(value?.height, Math.min(128, heightLimit), heightLimit, Math.min(192, heightLimit));
    geometry = { width, height,
      left: clamp(value?.left, 8, Math.max(8, window.innerWidth - width - 8), Math.max(8, window.innerWidth - width - 24)),
      top: clamp(value?.top, 8, Math.max(8, window.innerHeight - height - 8), Math.max(8, window.innerHeight - height - 24)) };
    for (const key of ['left','top','width','height']) host.style.setProperty(key, `${geometry[key]}px`);
    host.style.setProperty('right', 'auto'); host.style.setProperty('bottom', 'auto');
    if (ui.width) { ui.width.value = String(Math.round(width)); ui.height.value = String(Math.round(height)); }
  }
  function startGeometry(event, direction) {
    if (event.button !== 0 || mode !== 'inline') return;
    event.preventDefault(); settings(false);
    gesture = { direction, x:event.clientX, y:event.clientY, start:{ ...geometry }, pointerId:event.pointerId };
    host.dataset.manipulating = 'true'; host.dataset.keyboard = 'false'; reveal(true);
    host.setPointerCapture(event.pointerId);
  }
  function moveGeometry(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const { start, direction } = gesture, dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    const next = { ...start };
    if (direction === 'move') { next.left += dx; next.top += dy; }
    else {
      const minWidth = Math.min(340, window.innerWidth - 16), minHeight = Math.min(128, window.innerHeight - 16);
      if (direction.includes('e')) next.width = clamp(start.width + dx, minWidth, window.innerWidth - start.left - 8, start.width);
      if (direction.includes('s')) next.height = clamp(start.height + dy, minHeight, window.innerHeight - start.top - 8, start.height);
      if (direction.includes('w')) { next.left = clamp(start.left + dx, 8, start.left + start.width - minWidth, start.left); next.width = start.left + start.width - next.left; }
      if (direction.includes('n')) { next.top = clamp(start.top + dy, 8, start.top + start.height - minHeight, start.top); next.height = start.top + start.height - next.top; }
    }
    applyGeometry(next);
  }
  function endGeometry(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture = null; host.dataset.manipulating = 'false';
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    savePreferences(); centerCurrent(false);
    if (!host.matches(':hover')) reveal(false);
  }
  function safeCall(fn) {
    return async () => { try { await fn(); updateControls(); } catch (error) { setStatus(error?.message || '操作未完成，请检查视频页。'); } };
  }
  function button(text, label, handler, className = '') {
    const node = el('button', className, text);
    node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
    node.addEventListener('click', safeCall(handler)); return node;
  }
  function iconButton(name, label, handler, className = '') {
    const node = button('', label, handler, 'icon-button ' + className); node.append(icon(name)); return node;
  }
  function formatTime(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function updateControls() {
    if (!root) return;
    const paused = player.isPaused();
    if (ui.play.dataset.paused !== String(paused)) {
      ui.play.dataset.paused = String(paused); ui.play.replaceChildren(icon(paused ? 'play' : 'pause'));
      ui.play.setAttribute('aria-label', paused ? '播放视频' : '暂停视频'); ui.play.title = paused ? '播放视频' : '暂停视频';
    }
    const rate = String(player.getRate());
    if ([...ui.rate.options].some(option => option.value === rate)) ui.rate.value = rate;
    ui.clock.textContent = formatTime(time);
    ui.mode.textContent = '字幕';
    ui.follow.hidden = following;
    if (ui.windowButton.dataset.mode !== mode) {
      ui.windowButton.dataset.mode = mode;
      const label = mode === 'desktop' ? '回到页内' : '桌面置顶';
      ui.windowButton.replaceChildren(icon(mode === 'desktop' ? 'back' : 'pip'), el('span', '', label));
      ui.windowButton.setAttribute('aria-label', label); ui.windowButton.title = label;
    }
    ui.debug.textContent = `来源 ${source}${lang ? ' · ' + lang : ''}  |  ${cues.length} 句  |  ${time.toFixed(1)} s  |  索引 ${currentIndex >= 0 ? currentIndex : '—'}`;
  }
  function updateAppearance() {
    host.style.setProperty('--subtitle-size', `${fontSize}px`); host.style.setProperty('--surface-alpha', String((100 - transparency) / 100));
    host.style.setProperty('--caption-alpha', String(captionOpacity / 100)); host.dataset.theme = theme; host.dataset.layout = layout;
    ui.fontValue.textContent = `${fontSize}px`; ui.alphaValue.textContent = `${transparency}%`; ui.captionValue.textContent = `${captionOpacity}%`;
    ui.alpha.disabled = false;
    ui.alphaNote.textContent = '窗口透明度控制空白区域；字幕底色越高，文字背后遮挡越强。当前句以下划线标记。';
    ns.desktop?.setAppearance({fontSize,transparency,captionOpacity,theme,step,layout});
    if (ui.width) { ui.width.disabled = mode !== 'inline'; ui.height.disabled = mode !== 'inline'; ui.reset.disabled = mode !== 'inline'; }
  }
  function settings(open) {
    host.dataset.settings = String(open); ui.settings.hidden = !open; ui.settingsButton.setAttribute('aria-expanded', String(open));
    if (host.dataset.keyboard === 'true') (open ? ui.settingsBack : ui.settingsButton)?.focus();
  }
  function reveal(show) { const changed = host.dataset.revealed !== String(show); host.dataset.revealed = String(show); if (!show) settings(false); if (changed) centerCurrent(false); }
  function centerCurrent(smooth = true) {
    if (!following) return;
    const row = rows[currentIndex >= 0 ? currentIndex : Math.max(0, lastAnchor)];
    if (!row || !ui.lyrics) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // 只滚动字幕容器，不带动 B 站页面。
    const rects = row.getClientRects(), first = rects[0];
    if (!first) return;
    const view = ui.lyrics.getBoundingClientRect(), last = rects[rects.length - 1];
    const totalHeight = last.bottom - first.top;
    // 超长句从第一行开始展示，不把头尾同时裁掉；整句时间轴保持不变。
    const top = ui.lyrics.scrollTop + first.top - view.top - (totalHeight > ui.lyrics.clientHeight - 8 ? 4 : (ui.lyrics.clientHeight - totalHeight) / 2);
    ui.lyrics.scrollTo({ top, behavior: smooth && !reduced ? 'smooth' : 'auto' });
  }
  function restoreInline() {
    mode = 'inline'; host.dataset.mode = mode; host.hidden = false; launcher.hidden = true;
    applyGeometry(); reveal(false); updateAppearance(); updateControls(); centerCurrent(false);
  }
  async function openDesktop() {
    if (!ns.desktop) { setStatus('桌面助手模块未加载，请重新加载扩展并刷新视频页。'); reveal(true); return; }
    try { await ns.desktop.open(); }
    catch (error) { setStatus(error?.message || '透明桌面助手未连接。请先按 README 安装 native 桌面助手，再重试。'); reveal(true); }
  }
  function closeOrHide() {
    if (mode === 'desktop') ns.desktop?.close();
    else { host.hidden = true; launcher.hidden = false; }
  }
  function mount(playerApi) {
    player = playerApi; if (host) return;
    if (!document.body) throw new Error('视频页尚未准备好。');
    host = el('div'); host.id = 'bili-sub-overlay'; host.dataset.mode = mode; host.dataset.revealed = 'false'; host.dataset.settings = 'false'; host.tabIndex = 0;
    host.setAttribute('aria-label', '字幕条；移入鼠标或按 Tab 显示控制，Escape 收起');
    root = host.attachShadow({ mode:'open' });
    const style = el('style'); style.textContent = ns.overlayStyle; root.append(style);
    const card = el('section', 'card'); card.setAttribute('aria-label', 'B 站字幕');
    const topbar = el('div', 'topbar chrome');
    ui.mode = el('span', 'mode'); ui.status = el('span', 'status', status); ui.status.setAttribute('role', 'status'); ui.clock = el('span', 'clock', '0:00');
    ui.drag = el('div', 'drag-handle'); ui.drag.tabIndex = 0; ui.drag.setAttribute('role', 'button'); ui.drag.setAttribute('aria-label', '拖动字幕框，方向键微调位置');
    ui.drag.append(icon('move'), ui.mode, ui.status);
    ui.drag.addEventListener('pointerdown', event => startGeometry(event, 'move'));
    ui.drag.addEventListener('keydown', event => {
      if (mode !== 'inline' || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const delta = event.shiftKey ? 20 : 4;
      applyGeometry({ ...geometry, left:geometry.left + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0), top:geometry.top + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0) }); savePreferences();
    });
    ui.follow = button('跟随播放', '恢复自动跟随当前字幕', () => { following = true; centerCurrent(false); }, 'text-button'); ui.follow.hidden = true;
    topbar.append(ui.drag, ui.follow, ui.clock, iconButton('close', '关闭置顶窗或收起字幕', closeOrHide));
    ui.lyrics = el('div', 'lyrics'); ui.lyrics.setAttribute('aria-label', '字幕上下文，点击一句跳转');
    ui.lyrics.addEventListener('wheel', () => { following = false; updateControls(); }, { passive:true });
    ui.lyrics.addEventListener('touchmove', () => { following = false; updateControls(); }, { passive:true });
    const toolbar = el('nav', 'toolbar chrome'); toolbar.setAttribute('aria-label', '播放控制');
    ui.play = iconButton('play', '播放视频', () => player.toggle(), 'play');
    ui.back = button(`−${step}s`, '快退', () => player.seekBy(-step), 'skip'); ui.forward = button(`+${step}s`, '快进', () => player.seekBy(step), 'skip');
    ui.rate = el('select', 'rate'); ui.rate.setAttribute('aria-label', '播放倍速');
    [0.5,0.75,1,1.25,1.5,1.75,2,2.5,3].forEach(rate => { const option = el('option', '', `${rate}×`); option.value = String(rate); ui.rate.append(option); });
    ui.rate.addEventListener('change', safeCall(() => player.setRate(Number(ui.rate.value))));
    ui.settingsButton = iconButton('settings', '外观设置', () => settings(true)); ui.settingsButton.setAttribute('aria-expanded', 'false');
    ui.windowButton = button('', '桌面置顶', () => mode === 'desktop' ? ns.desktop.close() : openDesktop(), 'window-button');
    toolbar.append(iconButton('prev', '上一集或上一分P', () => player.prev()), ui.back, ui.play, ui.forward, iconButton('next', '下一集或下一分P', () => player.next()), el('span', 'separator'), ui.rate, el('span', 'separator'), ui.windowButton, ui.settingsButton);
    ui.settings = el('section', 'settings-panel chrome'); ui.settings.hidden = true; ui.settings.setAttribute('aria-label', '字幕外观设置');
    const settingsHeader = el('div', 'settings-header'); ui.settingsBack = iconButton('back', '返回字幕', () => settings(false));
    settingsHeader.append(el('span', '', '阅读样式'), ui.settingsBack);
    const grid = el('div', 'settings-grid');
    function field(label, input, output, className = '') {
      const wrap = el('label', 'field ' + className), heading = el('span', 'field-heading'); heading.append(el('span', '', label), output); wrap.append(heading, input); return wrap;
    }
    ui.alpha = el('input'); ui.alpha.type = 'range'; ui.alpha.min = '0'; ui.alpha.max = '100'; ui.alpha.value = String(transparency); ui.alpha.setAttribute('aria-label', '窗口透明度'); ui.alphaValue = el('span', 'value');
    ui.alpha.addEventListener('input', () => { transparency = clamp(ui.alpha.value, 0, 100, 100); updateAppearance(); savePreferences(); });
    ui.caption = el('input'); ui.caption.type = 'range'; ui.caption.min = '0'; ui.caption.max = '100'; ui.caption.value = String(captionOpacity); ui.caption.setAttribute('aria-label', '字幕底色不透明度'); ui.captionValue = el('span', 'value');
    ui.caption.addEventListener('input', () => { captionOpacity = clamp(ui.caption.value, 0, 100, 90); updateAppearance(); savePreferences(); });
    const font = el('input'); font.type = 'range'; font.min = '12'; font.max = '32'; font.value = String(fontSize); font.setAttribute('aria-label', '字幕字号'); ui.fontValue = el('span', 'value');
    font.addEventListener('input', () => { fontSize = clamp(font.value, 12, 32, 18); updateAppearance(); savePreferences(); centerCurrent(false); });
    const skip = el('input', 'step'); skip.type = 'number'; skip.min = '1'; skip.max = '120'; skip.value = String(step); skip.setAttribute('aria-label', '快进快退秒数');
    skip.addEventListener('change', () => { step = Math.round(clamp(skip.value, 1, 120, 10)); skip.value = String(step); ui.back.textContent = `−${step}s`; ui.forward.textContent = `+${step}s`; updateAppearance(); savePreferences(); });
    function select(label, choices, value, change) {
      const input = el('select', 'setting-select'); input.setAttribute('aria-label', label);
      for (const [key, text] of choices) { const option = el('option', '', text); option.value = key; input.append(option); }
      input.value = value; input.addEventListener('change', () => { change(input.value); updateAppearance(); savePreferences(); centerCurrent(false); }); return input;
    }
    const themeSelect = select('字幕配色', [['paper','浅色 · 深字'],['night','深色 · 浅字']], theme, value => { theme = value === 'night' ? 'night' : 'paper'; });
    const layoutSelect = select('字幕排版', [['flow','连续文本'],['lines','逐句换行']], layout, value => { layout = value === 'lines' ? 'lines' : 'flow'; });
    const sizes = el('div', 'size-fields');
    ui.width = el('input', 'step'); ui.width.type = 'number'; ui.width.min = '340'; ui.width.setAttribute('aria-label', '字幕框宽度');
    ui.height = el('input', 'step'); ui.height.type = 'number'; ui.height.min = '128'; ui.height.setAttribute('aria-label', '字幕框高度');
    for (const input of [ui.width,ui.height]) input.addEventListener('change', () => { applyGeometry({ ...geometry, width:Number(ui.width.value), height:Number(ui.height.value) }); savePreferences(); centerCurrent(false); });
    sizes.append(ui.width, el('span', '', '×'), ui.height);
    grid.append(field('字幕底色', ui.caption, ui.captionValue), field('窗口透明度', ui.alpha, ui.alphaValue), field('字号', font, ui.fontValue),
      field('配色', themeSelect, el('span')), field('排版', layoutSelect, el('span')),
      field('快进 / 快退', skip, el('span', 'value', '秒')), field('宽 × 高', sizes, el('span', 'value', 'px')));
    ui.reset = button('重置位置 / 大小', '重置字幕框位置和大小', () => { applyGeometry(null); savePreferences(); centerCurrent(false); }, 'text-button');
    ui.alphaNote = el('p', 'note'); const diagnostics = el('details', 'diagnostics'); diagnostics.append(el('summary', '', '调试信息')); ui.debug = el('pre', 'debug'); diagnostics.append(ui.debug);
    const settingsFooter = el('div', 'settings-footer'); settingsFooter.append(diagnostics, ui.reset);
    const settingsBody = el('div', 'settings-body'); settingsBody.append(grid, ui.alphaNote, settingsFooter);
    ui.settings.append(settingsHeader, settingsBody); card.append(ui.lyrics, topbar, toolbar, ui.settings); root.append(card);
    for (const direction of ['n','s','e','w','ne','nw','se','sw']) {
      const handle = el('div', `resize-handle resize-${direction} chrome`); handle.dataset.direction = direction; handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', event => startGeometry(event, direction)); root.append(handle);
    }
    host.addEventListener('pointermove', moveGeometry); host.addEventListener('pointerup', endGeometry); host.addEventListener('pointercancel', endGeometry);
    host.addEventListener('lostpointercapture', event => { if (gesture) endGeometry(event); });
    // 鼠标离开即收起，点击留下的焦点不会把工具条钉住。
    host.addEventListener('pointerenter', () => reveal(true));
    host.addEventListener('pointerleave', () => { if (!gesture && host.dataset.keyboard !== 'true') reveal(false); });
    host.addEventListener('pointerdown', () => { host.dataset.keyboard = 'false'; reveal(true); });
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape') { host.focus(); host.dataset.keyboard = 'false'; reveal(false); return; }
      if (['Tab','Enter',' '].includes(event.key)) { host.dataset.keyboard = 'true'; reveal(true); }
    });
    host.addEventListener('focus', () => { if (!host.matches?.(':hover')) host.dataset.keyboard = 'true'; reveal(true); });
    host.addEventListener('focusout', event => {
      // Shadow DOM 会把内部焦点的 relatedTarget 重定向为 host。
      if (host.matches?.(':hover') || event.relatedTarget === host || root.contains(event.relatedTarget)) return;
      host.dataset.keyboard = 'false'; reveal(false);
    });
    launcher = el('div'); launcher.id = 'bili-sub-launcher'; launcher.hidden = true;
    // 仅主动收起后提供恢复入口；正常显示时不出现额外固定按钮。
    launcher.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647';
    const show = button('字幕', '重新显示字幕', () => { if (mode === 'desktop') ns.desktop.close(); else { host.hidden = false; launcher.hidden = true; } });
    show.style.cssText = 'font:12px system-ui;color:#fff;background:#10121699;border:1px solid #ffffff22;border-radius:20px;padding:8px 14px;cursor:pointer';
    launcher.append(show); document.body.append(host, launcher);
    window.addEventListener('pagehide', () => ns.desktop?.close()); window.addEventListener('resize', () => { applyGeometry(); centerCurrent(false); });
    ns.desktop?.mount(player, {
      onOpen() { mode = 'desktop'; host.dataset.mode = mode; host.hidden = true; launcher.hidden = false; updateControls(); },
      onClose: restoreInline,
      onError: setStatus,
      onAppearance(value) {
        if (Number.isFinite(value.fontSize)) fontSize = clamp(value.fontSize,12,32,18);
        if (Number.isFinite(value.captionOpacity)) captionOpacity = clamp(value.captionOpacity,0,100,90);
        if (Number.isFinite(value.transparency)) transparency = clamp(value.transparency,0,100,95);
        if (value.theme === 'paper' || value.theme === 'night') theme = value.theme;
        if (value.layout === 'flow' || value.layout === 'lines') layout = value.layout;
        font.value = String(fontSize); ui.alpha.value = String(transparency); ui.caption.value = String(captionOpacity); themeSelect.value = theme; layoutSelect.value = layout;
        updateAppearance(); savePreferences(); centerCurrent(false);
      }
    });
    applyGeometry(); updateAppearance(); renderCues(); updateControls(); log('overlay-mounted', { version:'0.6.0', layout });
  }
  function renderCues() {
    if (!ui.lyrics) return;
    ui.lyrics.replaceChildren(); rows = [];
    if (!cues.length) { ui.empty = el('div', domLine ? 'domline' : 'empty', domLine || status || '等待字幕…'); ui.lyrics.append(ui.empty); return; }
    const fragment = document.createDocumentFragment();
    cues.forEach((cue, index) => {
      // span 能跨行分片；button 是原子行内盒，会把整句话挤到下一行。
      const row = el('span', 'line', cue.text); row.setAttribute('role', 'button'); row.title = `${formatTime(cue.start)} · 点击跳转`;
      const seek = safeCall(() => { following = true; player.seekTo(cue.start); centerCurrent(false); });
      row.addEventListener('click', seek);
      row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); seek(); } });
      row.dataset.index = String(index); row.tabIndex = -1; rows.push(row); const wrapper = el('span', 'cue-row'); wrapper.append(row); fragment.append(wrapper, document.createTextNode(' '));
    }); ui.lyrics.append(fragment);
  }
  function setCues(nextCues) {
    cues = Array.isArray(nextCues) ? nextCues.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start).map(c => ({ start:c.start, end:c.end, text:String(c.text ?? '') })).sort((a,b) => a.start - b.start) : [];
    ns.desktop?.setCues(cues); currentIndex = -1; lastAnchor = -1; domLine = ''; following = true; renderCues(); setCurrentTime(time); log('overlay-cues', { count:cues.length });
  }
  function setCurrentTime(nextTime) {
    time = Number.isFinite(nextTime) ? Math.max(0, nextTime) : 0; ns.desktop?.setCurrentTime(time);
    let low = 0, high = cues.length - 1, anchor = -1;
    while (low <= high) { const mid = (low + high) >> 1; if (cues[mid].start <= time) { anchor = mid; low = mid + 1; } else high = mid - 1; }
    const index = anchor >= 0 && time < cues[anchor].end ? anchor : -1;
    const changed = index !== currentIndex || anchor !== lastAnchor;
    if (index !== currentIndex) {
      if (rows[currentIndex]) { rows[currentIndex].classList.remove('active'); rows[currentIndex].removeAttribute('aria-current'); rows[currentIndex].tabIndex = -1; }
      currentIndex = index;
      if (rows[index]) { rows[index].classList.add('active'); rows[index].setAttribute('aria-current', 'true'); rows[index].tabIndex = 0; }
    }
    lastAnchor = anchor; if (changed || (anchor < 0 && rows.length)) centerCurrent(); updateControls();
  }
  function setStatus(message) {
    status = String(message || ''); ns.desktop?.setStatus(status); if (ui.status) { ui.status.textContent = status; ui.status.title = status; }
    if (!cues.length && !domLine && ui.empty) ui.empty.textContent = status || '等待字幕…';
  }
  function setDebug(info = {}) { if (info.source !== undefined) source = String(info.source); ns.desktop?.setSource(source); if (info.lang !== undefined) lang = String(info.lang); updateControls(); }
  function setCurrentLine(text) {
    domLine = String(text || ''); ns.desktop?.setCurrentLine(domLine); if (!cues.length && ui.empty) { ui.empty.className = domLine ? 'domline' : 'empty'; ui.empty.textContent = domLine || status || '等待下一句字幕…'; }
  }
  ns.overlay = { mount, setCues, setCurrentTime, setStatus, setDebug, setCurrentLine };
})();
