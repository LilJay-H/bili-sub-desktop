"use strict";
// 用 Node 自带模块验证事件、切集边界和过期状态；不访问网站。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeVideo extends EventTarget {
  constructor() {
    super();
    Object.assign(this, { currentTime: 20, duration: 100, readyState: 4, playbackRate: 1, paused: true, isConnected: true, clientWidth: 640 });
  }
  async play() { this.paused = false; this.dispatchEvent(new Event("play")); }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
}

function fixture() {
  const currentVideo = new FakeVideo();
  const document = new EventTarget();
  let videos = [currentVideo];
  document.querySelectorAll = selector => selector.includes("video") && !selector.includes(".multi-page") ? videos : [];
  const window = new EventTarget();
  window.__INITIAL_STATE__ = { videoData: { bvid: "BVtest1", aid: 101, cid: 201, title: "示例视频", pages: [{ page: 1, cid: 201, part: "第一段" }, { page: 2, cid: 202, part: "第二段" }] } };
  const location = { href: "https://www.bilibili.com/zh-Hans/video/BVtest1/", assign(url) { this.href = url; } };
  let timer;
  let mutation;
  const context = vm.createContext({ window, document, location, URL, console, queueMicrotask,
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} },
    setInterval(callback) { timer = callback; return 1; }, clearInterval() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../content/player.js"), "utf8"), context);
  return { player: window.BiliSub.player, window, document, location, currentVideo, tick: () => timer(), mutate: async () => { mutation(); await Promise.resolve(); }, replace: next => { videos = [next]; } };
}

(async () => {
  const env = fixture();
  const { player, currentVideo, window, location } = env;
  assert.equal(player.getVideoInfo().cid, 201);
  assert.equal(player.getVideoInfo().page, 1);
  let times = [];
  const offTime = player.onTime(value => times.push(value));
  assert.deepEqual(times, [20]);
  env.tick();
  assert.deepEqual(times, [20], "路由轮询不得驱动字幕时钟");
  currentVideo.currentTime = 21.5;
  currentVideo.dispatchEvent(new Event("timeupdate"));
  assert.equal(times.at(-1), 21.5);
  await player.toggle();
  assert.equal(player.isPaused(), false);
  player.toggle();
  assert.equal(player.isPaused(), true);
  player.seekBy(10);
  assert.equal(player.getTime(), 31.5);
  player.seekTo(-5);
  assert.equal(player.getTime(), 0);
  player.seekTo(1000);
  assert.equal(player.getTime(), 100);
  player.setRate(1.5);
  assert.equal(player.getRate(), 1.5);
  assert.throws(() => player.setRate(0), /0.25/);
  assert.throws(() => player.seekBy("wrong"), /无效/);
  assert.throws(() => player.prev(), /第一个分 P/);
  player.next();
  assert.equal(new URL(location.href).searchParams.get("p"), "2");
  env.tick();
  assert.equal(player.getVideoInfo().cid, 202);
  assert.throws(() => player.next(), /最后一个分 P/);
  player.prev();
  assert.equal(new URL(location.href).searchParams.get("p"), null);

  window.__INITIAL_STATE__.videoData.pages = [{ page: 1, cid: 201 }];
  window.__INITIAL_STATE__.videoData.ugc_season = { sections: [{ episodes: [{ bvid: "BVtest1", aid: 101 }, { bvid: "BVtest2", aid: 102 }] }] };
  player.next();
  assert.match(location.href, /BVtest2/);
  assert.equal(player.getVideoInfo().cid, null, "SPA 旧状态不能泄漏旧 cid");
  const changes = [];
  const offChange = player.onVideoChange(info => changes.push(info.key));
  env.tick();
  window.__INITIAL_STATE__ = { videoData: { bvid: "BVtest2", aid: 102, cid: 301 } };
  env.tick();
  assert.equal(player.getVideoInfo().cid, 301);
  assert.ok(changes.some(key => key.endsWith(":301")));

  const replacement = new FakeVideo();
  replacement.currentTime = 7;
  env.replace(replacement);
  await env.mutate();
  assert.equal(player.getTime(), 7);
  const length = times.length;
  currentVideo.dispatchEvent(new Event("timeupdate"));
  assert.equal(times.length, length, "旧 video 事件必须解绑");
  offTime(); offChange();
  replacement.dispatchEvent(new Event("timeupdate"));
  assert.equal(times.length, length);
  player.destroy();
  console.log("[bili-sub] player self-test PASS: video events, play/pause, seek bounds, rate, parts, collection, stale state, video replacement, unsubscribe");
})().catch(error => { console.error(error); process.exitCode = 1; });
