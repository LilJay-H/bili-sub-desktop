"use strict";
// 只允许已在测试视频中确认的字幕 CDN，不代理任意网络请求。
const cache = new Map();
function allowedUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "aisubtitle.hdslb.com" &&
      !u.port && !u.username && !u.password && /^\/bfs\/ai_subtitle\//.test(u.pathname) ? u.href : null;
  } catch (_) { return null; }
}
async function readSubtitle(url) {
  const response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("字幕文件读取失败");
  if (Number(response.headers.get("content-length")) > 8 * 1024 * 1024) throw new Error("字幕文件过大");
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("字幕文件过大"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(data.body)) throw new Error("字幕格式不支持");
  // 仅传递时间与正文，其余服务端字段不跨桥接传送。
  return { body: data.body.slice(0, 50000).map(c => ({ from: Number(c.from), to: Number(c.to), content: String(c.content || "").slice(0, 5000) })) };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "bili-sub-fetch") return;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab ||
      !/^https:\/\/www\.bilibili\.com\//.test(sender.url || "")) { respond({ ok: false, error: "请求来源不允许" }); return; }
  const url = allowedUrl(message.url);
  if (!url) { respond({ ok: false, error: "字幕域名不在实测白名单中" }); return; }
  if (!cache.has(url)) {
    const task = readSubtitle(url).then(data => ({ ok: true, data })).catch(() => ({ ok: false, error: "字幕文件读取失败或超时" }));
    cache.set(url, task);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  cache.get(url).then(respond);
  return true;
});
