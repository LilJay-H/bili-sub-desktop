(() => {
  "use strict";
  if (window !== top) return;
  let used = 0;
  const requests = new Map();
  window.addEventListener("message", async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const m = event.data;
    if (m?.channel !== "bili-sub-request" || typeof m.id !== "string" || m.id.length > 80 || typeof m.url !== "string" || m.url.length > 4096) return;
    let response, domainAllowed = false;
    try {
      const u = new URL(m.url);
      if (u.protocol !== "https:" || u.hostname !== "aisubtitle.hdslb.com" || !/^\/bfs\/ai_subtitle\//.test(u.pathname)) throw new Error();
      domainAllowed = true;
      if (!requests.has(u.href)) {
        if (++used > 40) throw new Error();
        requests.set(u.href, chrome.runtime.sendMessage({ type: "bili-sub-fetch", url: u.href }));
      }
      response = await requests.get(u.href);
    } catch (_) { response = { ok: false, error: domainAllowed ? "扩展需要重新加载" : "字幕域名不在实测白名单中" }; }
    window.postMessage({ channel: "bili-sub-response", id: m.id, ...response }, location.origin);
  });
})();
