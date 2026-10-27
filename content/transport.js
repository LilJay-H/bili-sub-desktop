(() => {
  "use strict";
  const ns = window.BiliSub = window.BiliSub || {};
  const cache = new Map();
  ns.fetchSubtitle = url => {
    if (cache.has(url)) return cache.get(url);
    const task = new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", listener); };
      const listener = event => {
        if (event.source !== window || event.origin !== location.origin || event.data?.channel !== "bili-sub-response" || event.data.id !== id) return;
        cleanup();
        if (event.data.ok) resolve(event.data.data);
        else {
          // 只映射固定错误，不把网页消息或网络异常原文展示给用户。
          const message = event.data.error === "字幕域名不在实测白名单中"
            ? "字幕域名不在白名单中"
            : event.data.error === "字幕文件读取失败或超时"
              ? "字幕文件读取失败或超时"
              : "字幕请求桥接失败，请刷新视频页";
          reject(new Error(message));
        }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("字幕桥接超时，请刷新视频页")); }, 18000);
      window.addEventListener("message", listener);
      window.postMessage({ channel: "bili-sub-request", id, url }, location.origin);
    });
    cache.set(url, task);
    return task;
  };
})();
