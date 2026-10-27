(() => {
  "use strict";
  const ns = window.BiliSub = window.BiliSub || {};
  if (ns.subtitle) return;

  const lists = new Map();
  const bodies = new Map();
  const results = new Map();
  const pendingRoutes = new Map();
  const resultDiagnostics = new WeakMap();
  const listeners = new Set();
  const wakeListeners = new Set();
  const xhrUrls = new WeakMap();
  const replayed = new Set();
  const originalFetch = window.fetch;
  let diagnostics = { source: "dom", lang: "", count: 0, message: "等待播放器字幕信息" };
  let observer = null;
  let domTimer = null;
  let currentLine = "";

  function log(message, details) {
    // 不输出地址、请求头或播放器原始响应。
    console.info("[bili-sub] " + message, details || "");
  }

  function notify() {
    for (const callback of wakeListeners) callback();
  }

  function safeUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== "https:" || url.username || url.password) return null;
      return url;
    } catch (_) { return null; }
  }

  function isPlayerUrl(url) {
    return url?.hostname === "api.bilibili.com" && /^\/x\/player\/(?:wbi\/)?v2\/?$/.test(url.pathname);
  }

  function isSubtitleUrl(url) {
    // 这里只决定是否旁路观察；真正下载的域名由扩展后台白名单再次检查。
    return url && ((url.hostname === "aisubtitle.hdslb.com" && /^\/bfs\/ai_subtitle\//.test(url.pathname)) ||
      (/(^|\.)hdslb\.com$/.test(url.hostname) && /^\/bfs\/subtitle\//.test(url.pathname)));
  }

  function normalizeCues(body) {
    if (!Array.isArray(body)) return [];
    return body.slice(0, 50000).map(item => ({
      start: Number(item?.from ?? item?.start),
      end: Number(item?.to ?? item?.end),
      text: typeof (item?.content ?? item?.text) === "string" ? (item.content ?? item.text).slice(0, 5000).trim() : ""
    })).filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end > item.start && item.text)
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function trimCache(map, max) {
    while (map.size > max) map.delete(map.keys().next().value);
  }

  function acceptResponse(url, payload) {
    if (!payload || typeof payload !== "object") return;
    if (isPlayerUrl(url)) {
      const cid = String(url.searchParams.get("cid") || "");
      if (!/^\d+$/.test(cid)) return;
      const rawList = payload.data?.subtitle?.subtitles;
      const code = Number(payload.code);
      // 仅保留字幕字段，用户资料等字段不进入缓存。
      const subtitles = Array.isArray(rawList) ? rawList.slice(0, 40).map(item => ({
        lang: String(item.lan || ""),
        name: String(item.lan_doc || ""),
        ai: Number(item.ai_type) > 0 || /^ai-/i.test(item.lan || "") || /自动|AI/i.test(item.lan_doc || ""),
        url: safeUrl(item.subtitle_url)?.href || ""
      })).filter(item => item.url) : null;
      lists.set(cid, { cid, aid: url.searchParams.get("aid") || "", bvid: url.searchParams.get("bvid") || "", code, subtitles });
      trimCache(lists, 40);
      log("捕获字幕列表", { count: subtitles?.length || 0, code: Number.isFinite(code) ? code : null });
      notify();
    } else if (isSubtitleUrl(url) || bodies.has(url.href)) {
      const cues = normalizeCues(payload.body);
      if (cues.length) {
        bodies.set(url.href, cues);
        trimCache(bodies, 40);
        notify();
      }
    }
  }

  function requestUrl(input) {
    return safeUrl(typeof input === "string" || input instanceof URL ? String(input) : input?.url);
  }

  function installInterceptors() {
    if (typeof window.fetch === "function") {
      window.fetch = function (...args) {
        const url = requestUrl(args[0]);
        const promise = Reflect.apply(originalFetch, this, args);
        if (isPlayerUrl(url) || isSubtitleUrl(url)) {
          // 不等待旁路解析，不改变网站原有 Promise 的结果。
          promise.then(response => {
            if (response.ok) response.clone().json().then(data => acceptResponse(url, data)).catch(() => {});
          }).catch(() => {});
        }
        return promise;
      };
    }
    if (typeof XMLHttpRequest === "function") {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        xhrUrls.set(this, safeUrl(url));
        return Reflect.apply(originalOpen, this, [method, url, ...rest]);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        const url = xhrUrls.get(this);
        if (isPlayerUrl(url) || isSubtitleUrl(url)) {
          this.addEventListener("load", () => {
            if (this.status < 200 || this.status >= 300) return;
            try {
              const data = this.responseType === "json" ? this.response :
                (!this.responseType || this.responseType === "text") ? JSON.parse(this.responseText) : null;
              acceptResponse(url, data);
            } catch (_) { /* 页面非 JSON 响应不影响原请求。 */ }
          }, { once: true });
        }
        return Reflect.apply(originalSend, this, args);
      };
    }
  }

  function videoInfo() {
    try { return ns.player?.getVideoInfo() || {}; }
    catch (_) { return {}; }
  }

  function routeKey() {
    const url = new URL(location.href);
    const id = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i)?.[1] || url.pathname;
    return `${id}:${Math.max(1, Number(url.searchParams.get("p")) || 1)}`;
  }

  function matchingList(info) {
    if (info.cid) return lists.get(String(info.cid)) || null;
    // 无 cid 时不能用“最近一个响应”猜测，避免切视频后错配字幕。
    return null;
  }

  function replayObservedList(info) {
    const cid = String(info.cid || "");
    if (!cid || replayed.has(cid) || typeof originalFetch !== "function") return;
    // 晚注入兜底：只重放本页确实请求过、且 cid 匹配的地址，不生成签名或猜测接口。
    const entries = window.performance?.getEntriesByType("resource") || [];
    const observed = entries.slice().reverse().map(entry => safeUrl(entry.name))
      .find(url => isPlayerUrl(url) && url.searchParams.get("cid") === cid);
    if (!observed) return;
    replayed.add(cid);
    log("重放本页已观察到的播放器接口", { mode: "once" });
    // api 与 www 是同站跨源；凭证由浏览器自然携带，脚本不读取。
    Reflect.apply(originalFetch, window, [observed.href, { credentials: "include" }])
      .then(response => response.ok ? response.json() : null)
      .then(payload => { if (payload) acceptResponse(observed, payload); })
      .catch(() => { log("播放器信息读取失败，将使用当前句模式"); });
  }

  function waitForList(request) {
    return new Promise(resolve => {
      const started = Date.now();
      let timer;
      const finish = value => {
        clearTimeout(timer);
        wakeListeners.delete(check);
        resolve(value);
      };
      const check = () => {
        clearTimeout(timer);
        const info = videoInfo();
        if (request.route !== routeKey() || (request.cid && info.cid && String(request.cid) !== String(info.cid))) return finish({ changed: true });
        if (!request.cid && info.cid) request.cid = String(info.cid);
        const list = matchingList(info);
        if (list) return finish({ list, info });
        if (Date.now() - started >= 600) replayObservedList(info);
        if (Date.now() - started >= 8000) return finish({ info });
        timer = setTimeout(check, 200);
      };
      wakeListeners.add(check);
      check();
    });
  }

  function preferredSubtitle(subtitles) {
    const score = item => {
      const chinese = /^(?:ai-)?zh(?:-|$)/i.test(item.lang) || /中文|汉语|普通话/.test(item.name);
      return (chinese ? 0 : 4) + (item.ai ? 2 : 0) + (/zh-Hans|zh-CN/.test(item.lang) ? 0 : 1);
    };
    return subtitles.slice().sort((a, b) => score(a) - score(b))[0];
  }

  function domResult(message) {
    diagnostics = { source: "dom", lang: "", count: 0, message };
    log(message, { source: "dom", count: 0 });
    const result = { source: "dom", lang: "", cues: [] };
    resultDiagnostics.set(result, { ...diagnostics });
    return result;
  }

  async function resolveSubtitles(request) {
    const found = await waitForList(request);
    if (found.changed) {
      const error = new Error("视频已经切换，正在读取新视频字幕");
      error.code = "VIDEO_CHANGED";
      throw error;
    }
    if (request.cid) {
      results.set(request.cid, request.promise);
      trimCache(results, 40);
    }
    const { list } = found;
    if (!list) return domResult("未捕获字幕列表，请刷新视频页；也可在 B 站播放器开启字幕以尝试当前句模式");
    if (list.code === -101) throw new Error("需要登录 B 站后才能读取字幕，请手动检查登录状态");
    if ([-352, -412, -509].includes(list.code)) throw new Error("B 站要求安全验证，已停止读取，请手动检查页面");
    if (list.code !== 0 || !Array.isArray(list.subtitles)) return domResult("播放器没有返回可用字幕信息，可尝试开启 B 站字幕显示当前句");
    if (!list.subtitles.length) return domResult("此视频没有可用字幕；若播放器能显示字幕，将尝试仅显示当前句");
    const selected = preferredSubtitle(list.subtitles);
    let cues = bodies.get(selected.url);
    let source = "intercept";
    if (!cues) {
      // 给播放器自己的字幕请求短暂机会，避免重复下载。
      await new Promise(resolve => setTimeout(resolve, 350));
      cues = bodies.get(selected.url);
    }
    if (!cues) {
      if (typeof ns.fetchSubtitle !== "function") return domResult("字幕文件请求桥接尚未就绪，请刷新页面后重试");
      source = "api";
      try {
        const payload = await ns.fetchSubtitle(selected.url);
        cues = normalizeCues(payload?.body ?? payload?.cues ?? payload);
      } catch (error) {
        // 异常文本可能携带地址，只显示自己定义的错误说明。
        const detail = String(error?.message || "");
        const message = /域名|白名单/.test(detail) ? "字幕文件域名尚未授权；当前仅能尝试播放器当前句模式" :
          /超时/.test(detail) ? "字幕文件读取超时；可开启 B 站字幕尝试当前句模式" :
          /登录/.test(detail) ? "需要登录后读取字幕，请手动检查登录状态" :
          /过大/.test(detail) ? "字幕文件过大；当前仅能尝试播放器当前句模式" :
          "字幕文件读取失败；可开启 B 站字幕尝试当前句模式";
        return domResult(message);
      }
      if (cues.length) {
        bodies.set(selected.url, cues);
        trimCache(bodies, 40);
      }
    }
    if (!cues?.length) return domResult("字幕文件为空或格式不支持，可尝试 B 站播放器的当前句模式");
    diagnostics = { source, lang: selected.lang, count: cues.length, message: selected.ai ? "已载入 AI 字幕" : "已载入字幕" };
    log("字幕已就绪", { source, lang: selected.lang, count: cues.length });
    const result = { source, lang: selected.lang, cues };
    resultDiagnostics.set(result, { ...diagnostics });
    return result;
  }

  function getSubtitles() {
    const info = videoInfo();
    const route = routeKey();
    const cid = info.cid ? String(info.cid) : null;
    if (cid && results.has(cid)) return results.get(cid);
    const pending = pendingRoutes.get(route);
    if (pending && (!cid || !pending.cid || cid === pending.cid)) return pending.promise;
    // 同一视频共享进行中的 Promise，失败也缓存，避免反复请求。
    const request = { route, cid, promise: null };
    request.promise = resolveSubtitles(request);
    pendingRoutes.set(route, request);
    if (cid) results.set(cid, request.promise);
    const cleanup = error => {
      if (pendingRoutes.get(route) === request) pendingRoutes.delete(route);
      if (error?.code === "VIDEO_CHANGED" && request.cid && results.get(request.cid) === request.promise) results.delete(request.cid);
    };
    request.promise.then(() => cleanup(), cleanup);
    trimCache(results, 40);
    return request.promise;
  }

  function readCurrentLine() {
    const selectors = [".bpx-player-subtitle-panel-text", ".bpx-player-subtitle-panel .subtitle-item-text", ".bilibili-player-video-subtitle .subtitle-item-text", ".bpx-player-subtitle-panel"];
    let text = "";
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      text = nodes.filter(node => node.getClientRects().length && !node.closest("[data-bili-sub]"))
        .map(node => (node.textContent || "").trim()).filter(Boolean).join("\n").slice(0, 2000);
      if (text) break;
    }
    if (text === currentLine) return;
    currentLine = text;
    for (const callback of listeners) {
      try { callback(text); } catch (_) { log("当前句回调执行失败"); }
    }
  }

  function startDomObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(() => {
      if (!domTimer) domTimer = setTimeout(() => { domTimer = null; readCurrentLine(); }, 80);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    readCurrentLine();
  }

  function onCurrentLine(callback) {
    if (typeof callback !== "function") throw new TypeError("当前句订阅需要回调函数");
    listeners.add(callback);
    if (document.documentElement) startDomObserver();
    else document.addEventListener("DOMContentLoaded", startDomObserver, { once: true });
    callback(currentLine);
    return () => {
      listeners.delete(callback);
      if (!listeners.size && observer) {
        observer.disconnect();
        observer = null;
        clearTimeout(domTimer);
        domTimer = null;
      }
    };
  }

  ns.subtitle = { getSubtitles, onCurrentLine, getDiagnostics: result => ({ ...(resultDiagnostics.get(result) || diagnostics) }) };
  installInterceptors();
})();
