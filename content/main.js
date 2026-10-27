(() => {
  "use strict";
  const ns = window.BiliSub = window.BiliSub || {};
  if (ns.started) return;
  ns.started = true;
  let generation = 0, unsubscribeLine = null, mounted = false;
  async function load(info) {
    const current = ++generation;
    unsubscribeLine?.(); unsubscribeLine = null;
    if (!/\/video\/(BV[\w]+|av\d+)/i.test(location.pathname)) {
      if (mounted) { ns.overlay.setCues([]); ns.overlay.setStatus("请打开 B 站视频页。"); }
      return;
    }
    if (!document.body) return;
    if (!mounted) { ns.overlay.mount(ns.player); mounted = true; }
    ns.overlay.setCues([]);
    ns.overlay.setDebug({ source: "等待", lang: "" });
    ns.overlay.setStatus("正在读取字幕…");
    console.info("[bili-sub] video-change", { page: info.page, ready: !!info.cid });
    if (!info.cid) ns.overlay.setStatus("正在等待播放器信息…");
    try {
      const result = await ns.subtitle.getSubtitles();
      if (current !== generation) return;
      ns.overlay.setDebug(result);
      ns.overlay.setCues(result.cues);
      ns.overlay.setStatus(ns.subtitle.getDiagnostics(result).message);
      ns.overlay.setCurrentTime(ns.player.getTime());
      if (result.source === "dom") unsubscribeLine = ns.subtitle.onCurrentLine(line => {
        ns.overlay.setCurrentLine(line);
        if (line) ns.overlay.setStatus("当前句模式：没有完整上下文，请保持 B 站字幕开启。");
      });
      console.info("[bili-sub] ready", { source: result.source, lang: result.lang, count: result.cues.length });
    } catch (error) {
      if (current !== generation) return;
      ns.overlay.setStatus(error.message || "字幕读取失败，请检查视频页面。");
      console.info("[bili-sub] subtitle-unavailable");
    }
  }
  function start() {
    ns.player.onTime(time => { if (mounted) ns.overlay.setCurrentTime(time); });
    ns.player.onVideoChange(load);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
