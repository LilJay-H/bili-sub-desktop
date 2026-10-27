(() => {
  "use strict";
  const namespace = window.BiliSub = window.BiliSub || {};
  if (namespace.player) return;

  const timeListeners = new Set();
  const changeListeners = new Set();
  const mediaEvents = ["timeupdate", "seeking", "seeked", "play", "pause", "ratechange", "durationchange", "loadedmetadata", "ended", "emptied"];
  let video = null;
  let lastIdentity = "";
  let refreshQueued = false;
  let stopped = false;

  function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function routeInfo() {
    const url = new URL(location.href);
    const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    return {
      bvid: match && /^BV/i.test(match[1]) ? match[1] : null,
      aid: match && /^av/i.test(match[1]) ? positiveNumber(match[1].slice(2)) : null,
      page: Math.max(1, Math.floor(positiveNumber(url.searchParams.get("p")) || 1))
    };
  }

  function matchingVideoData(route) {
    const state = window.__INITIAL_STATE__ || {};
    const data = state.videoData || {};
    // SPA 切换期间旧状态可能仍在，不能把上一集的 cid 交给字幕模块。
    if (route.bvid && data.bvid !== route.bvid) return null;
    if (route.aid && Number(data.aid) !== route.aid) return null;
    return data;
  }

  function getVideoInfo() {
    const route = routeInfo();
    const data = matchingVideoData(route);
    const pages = Array.isArray(data?.pages) ? data.pages : [];
    const part = pages.find(item => Number(item.page) === route.page) || pages[route.page - 1];
    let nativeInfo = null;
    try {
      // 只读取播放器公开的视频标识，不读取账号或网络请求头。
      nativeInfo = typeof window.player?.getVideoInfo === "function" ? window.player.getVideoInfo() : null;
    } catch (_) { /* 页面播放器尚未就绪。 */ }
    const nativeMatches = nativeInfo && (
      (route.bvid && nativeInfo.bvid === route.bvid) ||
      (route.aid && Number(nativeInfo.aid) === route.aid) ||
      (data && Number(nativeInfo.aid) === Number(data.aid))
    );
    const cid = positiveNumber(part?.cid) ||
      (nativeMatches && positiveNumber(nativeInfo.cid)) ||
      (route.page === 1 && positiveNumber(data?.cid)) || null;
    return {
      bvid: route.bvid || data?.bvid || null,
      aid: route.aid || positiveNumber(data?.aid) || (nativeMatches && positiveNumber(nativeInfo.aid)) || null,
      cid,
      page: route.page,
      title: typeof part?.part === "string" ? part.part : (typeof data?.title === "string" ? data.title : ""),
      key: `${route.bvid || route.aid || "unknown"}:${route.page}:${cid || "pending"}`
    };
  }

  function invoke(listeners, value) {
    for (const listener of listeners) {
      try { listener(value); }
      catch (_) { console.warn("[bili-sub] 播放订阅回调执行失败"); }
    }
  }

  function emitTime() {
    invoke(timeListeners, getTime());
  }

  function checkIdentity(force = false) {
    const info = getVideoInfo();
    if (force || info.key !== lastIdentity) {
      lastIdentity = info.key;
      invoke(changeListeners, info);
    }
  }

  function onMediaEvent(event) {
    if (event.type === "loadedmetadata" || event.type === "emptied") checkIdentity();
    emitTime();
  }

  function findVideo() {
    const candidates = [...document.querySelectorAll(".bpx-player-video-wrap video, .bilibili-player-video video")];
    if (!candidates.length) candidates.push(...document.querySelectorAll("video"));
    return candidates.find(item => item.isConnected && !item.paused) ||
      candidates.find(item => item.isConnected && item.clientWidth > 0) ||
      candidates.find(item => item.isConnected) || null;
  }

  function refresh() {
    if (stopped) return;
    const nextVideo = findVideo();
    const replaced = nextVideo !== video;
    if (replaced) {
      if (video) mediaEvents.forEach(name => video.removeEventListener(name, onMediaEvent));
      video = nextVideo;
      if (video) mediaEvents.forEach(name => video.addEventListener(name, onMediaEvent));
    }
    checkIdentity(replaced);
    if (replaced) emitTime();
  }

  function requireVideo() {
    refresh();
    if (!video) throw new Error("还没找到视频播放器，请等待视频加载完成。");
    return video;
  }

  function getTime() { return Number.isFinite(video?.currentTime) ? video.currentTime : 0; }
  function getRate() { return Number.isFinite(video?.playbackRate) ? video.playbackRate : 1; }
  function isPaused() { return !video || video.paused; }

  async function play() {
    const current = requireVideo();
    try { await current.play(); }
    catch (_) { throw new Error("浏览器暂时不允许播放，请先在 B 站页面点击一次播放。"); }
  }
  function pause() { requireVideo().pause(); }
  function toggle() { return requireVideo().paused ? play() : pause(); }

  function seekTo(time) {
    const current = requireVideo();
    const number = Number(time);
    if (!Number.isFinite(number)) throw new Error("跳转时间无效。");
    if (current.readyState === 0) throw new Error("视频信息尚未加载，请稍后再跳转。");
    const end = Number.isFinite(current.duration) ? current.duration : Infinity;
    try { current.currentTime = Math.max(0, Math.min(end, number)); }
    catch (_) { throw new Error("这段视频暂时无法跳转，请等待加载后重试。"); }
    emitTime();
  }

  function seekBy(deltaSeconds) {
    requireVideo();
    const delta = Number(deltaSeconds);
    if (!Number.isFinite(delta)) throw new Error("快进秒数无效。");
    seekTo(getTime() + delta);
  }

  function setRate(rate) {
    const number = Number(rate);
    if (!Number.isFinite(number) || number < 0.25 || number > 4) throw new Error("请选择 0.25 到 4 倍之间的播放速度。");
    try { requireVideo().playbackRate = number; }
    catch (_) { throw new Error("播放器暂时无法改变倍速。"); }
    emitTime();
  }

  function videoUrl(bvid, aid, page = 1) {
    const identifier = /^BV[0-9A-Za-z]+$/.test(bvid || "") ? bvid : (positiveNumber(aid) ? `av${Number(aid)}` : null);
    if (!identifier) return null;
    const url = new URL(`/video/${identifier}/`, "https://www.bilibili.com");
    if (page > 1) url.searchParams.set("p", String(page));
    return url.href;
  }

  function stateNavigation(direction) {
    const route = routeInfo();
    const data = matchingVideoData(route);
    if (!data) return null;
    const pages = Array.isArray(data.pages) ? data.pages : [];
    if (pages.length > 1) {
      const index = pages.findIndex(item => Number(item.page) === route.page);
      const nextPart = pages[(index >= 0 ? index : route.page - 1) + direction];
      if (!nextPart) throw new Error(direction < 0 ? "已经是第一个分 P。" : "已经是最后一个分 P。");
      return videoUrl(data.bvid, data.aid, Number(nextPart.page) || route.page + direction);
    }
    const sections = data.ugc_season?.sections;
    const episodes = Array.isArray(sections) ? sections.flatMap(section => Array.isArray(section.episodes) ? section.episodes : []) : [];
    const index = episodes.findIndex(item => (item.bvid || item.arc?.bvid) === route.bvid || Number(item.aid || item.arc?.aid) === Number(data.aid));
    if (index < 0) return null;
    const nextEpisode = episodes[index + direction];
    if (!nextEpisode) throw new Error(direction < 0 ? "已经是合集第一集。" : "已经是合集最后一集。");
    return videoUrl(nextEpisode.bvid || nextEpisode.arc?.bvid, nextEpisode.aid || nextEpisode.arc?.aid);
  }

  function safeVideoLink(anchor) {
    try {
      const url = new URL(anchor.href, location.href);
      if (url.protocol !== "https:" || url.hostname !== "www.bilibili.com" || !/\/video\/(BV[0-9A-Za-z]+|av\d+)\/?$/i.test(url.pathname)) return null;
      const match = url.pathname.match(/\/video\/([^/]+)/);
      const page = Math.max(1, Number(url.searchParams.get("p")) || 1);
      return { url: videoUrl(match[1], /^av/.test(match[1]) ? match[1].slice(2) : null, page), identifier: match[1], page };
    } catch (_) { return null; }
  }

  function domNavigation(direction) {
    const route = routeInfo();
    const identifier = route.bvid || (route.aid ? `av${route.aid}` : "");
    // 只检查播放器的分 P / 合集列表；绝不点击推荐、互动或账号按钮。
    const containers = document.querySelectorAll(".multi-page .list-box, .video-sections-content-list, .video-pod__list, .video-episode-card__list, .video-pod__body");
    for (const container of containers) {
      const seen = new Set();
      const links = [...container.querySelectorAll("a[href]")].map(safeVideoLink).filter(item => {
        if (!item || seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
      const index = links.findIndex(item => item.identifier === identifier && item.page === route.page);
      if (index < 0 || links.length < 2) continue;
      if (!links[index + direction]) throw new Error(direction < 0 ? "列表中没有上一集。" : "列表中没有下一集。");
      return links[index + direction].url;
    }
    return null;
  }

  function navigate(direction) {
    const target = stateNavigation(direction) || domNavigation(direction);
    if (!target) throw new Error("没有找到可用的分 P 或合集列表，请在 B 站页面手动切集；字幕会自动重新加载。");
    // 使用普通视频链接最稳定；整页导航时浏览器会关闭画中画，需要重新点击打开。
    location.assign(target);
  }

  function subscribe(listeners, callback, initialValue) {
    if (typeof callback !== "function") throw new TypeError("订阅需要传入函数。");
    listeners.add(callback);
    try { callback(initialValue()); } catch (_) { console.warn("[bili-sub] 播放订阅回调执行失败"); }
    return () => listeners.delete(callback);
  }

  const observer = new MutationObserver(() => {
    if (refreshQueued || stopped) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; refresh(); });
  });
  observer.observe(document, { childList: true, subtree: true });
  // 轮询仅识别路由和视频替换；字幕时钟由 video 事件驱动。
  const routeTimer = setInterval(refresh, 1000);
  window.addEventListener("popstate", refresh);
  window.addEventListener("pageshow", refresh);
  document.addEventListener("visibilitychange", refresh);
  refresh();

  namespace.player = {
    play, pause, toggle, seekBy, seekTo, setRate, getRate, getTime, isPaused,
    prev: () => navigate(-1),
    next: () => navigate(1),
    onTime: callback => subscribe(timeListeners, callback, getTime),
    onVideoChange: callback => subscribe(changeListeners, callback, getVideoInfo),
    getVideoInfo,
    destroy() {
      stopped = true;
      clearInterval(routeTimer);
      observer.disconnect();
      window.removeEventListener("popstate", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
      if (video) mediaEvents.forEach(name => video.removeEventListener(name, onMediaEvent));
      timeListeners.clear();
      changeListeners.clear();
    }
  };
})();
