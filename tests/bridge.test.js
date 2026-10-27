"use strict";
// 两个 VM 模拟 MAIN / ISOLATED world；只用消息总线，不访问真实网页。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const bridgeSource = fs.readFileSync(path.join(__dirname, "../content/bridge.js"), "utf8");
const transportSource = fs.readFileSync(path.join(__dirname, "../content/transport.js"), "utf8");
const origin = "https://www.bilibili.com";
const subtitleUrl = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/bridge-test.json";
const payload = { body: [{ from: 1, to: 3, content: "消息往返测试" }] };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(runtimeHandler = async () => ({ ok: true, data: payload })) {
  const worlds = [];
  const outbound = [];
  const runtimeMessages = [];
  const timers = new Map();
  let nextTimer = 0;
  function createWorld(name) {
    const listeners = new Set();
    const window = {
      addEventListener(type, listener) { if (type === "message") listeners.add(listener); },
      removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); },
      postMessage(data, targetOrigin) {
        outbound.push({ world: name, data: structuredClone(data), targetOrigin });
        if (targetOrigin !== origin) throw new Error("Unexpected postMessage target origin");
        // WindowProxy 在各世界中应当与各自的 window 相等。
        for (const world of worlds) queueMicrotask(() => world.deliver(data));
      }
    };
    const world = { name, window, listeners,
      deliver(data, overrides = {}) {
        const event = { source: window, origin, data: structuredClone(data), ...overrides };
        for (const listener of [...listeners]) listener(event);
      }
    };
    worlds.push(world);
    return world;
  }
  const main = createWorld("main");
  const isolated = createWorld("isolated");
  vm.runInContext(bridgeSource, vm.createContext({
    window: isolated.window, top: isolated.window, location: { origin }, URL,
    chrome: { runtime: { sendMessage(message) { runtimeMessages.push(structuredClone(message)); return runtimeHandler(message); } } }
  }));
  vm.runInContext(transportSource, vm.createContext({
    window: main.window, location: { origin }, crypto: { randomUUID },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  }));
  return { main, isolated, outbound, runtimeMessages, timers,
    fetch: url => main.window.BiliSub.fetchSubtitle(url),
    expireTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.callback()); }
  };
}

(async () => {
  const env = fixture();
  const first = env.fetch(subtitleUrl);
  const concurrent = env.fetch(subtitleUrl);
  assert.strictEqual(first, concurrent, "同 URL 应共用主世界 Promise");
  assert.deepEqual(await first, payload);
  assert.deepEqual(await concurrent, payload);
  assert.equal(env.runtimeMessages.length, 1);
  assert.deepEqual(await env.fetch(subtitleUrl), payload);
  assert.equal(env.runtimeMessages.length, 1, "缓存命中不应重新经过 runtime");
  assert.equal(env.timers.size, 0, "成功后应清理超时定时器");
  assert.equal(env.main.listeners.size, 0, "成功后应清理临时消息监听器");
  assert.ok(env.outbound.every(message => message.targetOrigin === origin));
  assert.equal(env.runtimeMessages[0].type, "bili-sub-fetch");
  assert.equal(env.runtimeMessages[0].url, subtitleUrl);

  // 绕开主世界缓存，直接验证隔离世界也只转发一次。
  env.main.window.postMessage({ channel: "bili-sub-request", id: "direct-a", url: subtitleUrl }, origin);
  env.main.window.postMessage({ channel: "bili-sub-request", id: "direct-b", url: subtitleUrl }, origin);
  await tick();
  assert.equal(env.runtimeMessages.length, 1);
  assert.ok(env.outbound.some(item => item.data.channel === "bili-sub-response" && item.data.id === "direct-a" && item.data.ok));
  assert.ok(env.outbound.some(item => item.data.channel === "bili-sub-response" && item.data.id === "direct-b" && item.data.ok));

  const denied = fixture();
  for (const url of [
    "https://other.invalid/bfs/ai_subtitle/file.json",
    "https://aisubtitle.hdslb.com.evil.invalid/bfs/ai_subtitle/file.json",
    "http://aisubtitle.hdslb.com/bfs/ai_subtitle/file.json",
    "https://aisubtitle.hdslb.com/unapproved/file.json",
    "not-a-url"
  ]) await assert.rejects(denied.fetch(url), /字幕域名不在白名单中/);
  assert.equal(denied.runtimeMessages.length, 0, "非法域名/协议/路径不得转发 runtime");
  assert.equal(denied.main.listeners.size, 0);
  assert.equal(denied.timers.size, 0);

  const filter = fixture();
  const validRequest = { channel: "bili-sub-request", id: "filter-id", url: subtitleUrl };
  filter.isolated.deliver(validRequest, { source: {} });
  filter.isolated.deliver(validRequest, { origin: "https://other.invalid" });
  filter.isolated.deliver({ ...validRequest, channel: "other-channel" });
  filter.isolated.deliver({ ...validRequest, id: "x".repeat(81) });
  filter.isolated.deliver({ ...validRequest, url: "x".repeat(4097) });
  await tick();
  assert.equal(filter.runtimeMessages.length, 0, "非法消息不得触发后台请求");
  assert.equal(filter.outbound.length, 0, "非法发送者/来源/结构应忽略而非响应");

  let release;
  const responseFilter = fixture(() => new Promise(resolve => { release = resolve; }));
  let settled = false;
  const pending = responseFilter.fetch(subtitleUrl).then(value => { settled = true; return value; });
  await tick();
  const requestId = responseFilter.outbound.find(item => item.data.channel === "bili-sub-request").data.id;
  const forged = { channel: "bili-sub-response", id: requestId, ok: true, data: { forged: true } };
  responseFilter.main.deliver(forged, { source: {} });
  responseFilter.main.deliver(forged, { origin: "https://other.invalid" });
  responseFilter.main.deliver({ ...forged, id: "different-id" });
  responseFilter.main.deliver({ ...forged, channel: "other-channel" });
  await tick();
  assert.equal(settled, false, "主世界应忽略错误来源或 ID 的响应");
  release({ ok: true, data: payload });
  assert.deepEqual(await pending, payload);

  for (const handler of [
    () => { throw new Error("PRIVATE_RAW_EXCEPTION"); },
    async () => { throw new Error("PRIVATE_RAW_EXCEPTION"); }
  ]) {
    const broken = fixture(handler);
    await assert.rejects(broken.fetch(subtitleUrl), /字幕请求桥接失败，请刷新视频页/);
    assert.equal(JSON.stringify(broken.outbound).includes("PRIVATE_RAW_EXCEPTION"), false, "runtime 原始异常不得进入消息总线");
    assert.equal(broken.main.listeners.size, 0);
    assert.equal(broken.timers.size, 0);
  }

  const networkError = fixture(async () => ({ ok: false, error: "字幕文件读取失败或超时" }));
  await assert.rejects(networkError.fetch(subtitleUrl), error => {
    assert.equal(error.message, "字幕文件读取失败或超时");
    assert.equal(error.message.includes("域名"), false, "网络错误不得误报域名错误");
    return true;
  });
  const unknownError = fixture(async () => ({ ok: false, error: "UNTRUSTED_SERVER_TEXT" }));
  await assert.rejects(unknownError.fetch(subtitleUrl), error => error.message === "字幕请求桥接失败，请刷新视频页");
  const explicitDenied = fixture(async () => ({ ok: false, error: "字幕域名不在实测白名单中" }));
  await assert.rejects(explicitDenied.fetch(subtitleUrl), /字幕域名不在白名单中/);

  const timeout = fixture(() => new Promise(() => {}));
  const timedOut = assert.rejects(timeout.fetch(subtitleUrl), /字幕桥接超时，请刷新视频页/);
  await tick();
  assert.equal([...timeout.timers.values()][0].delay, 18000);
  timeout.expireTimers();
  await timedOut;
  assert.equal(timeout.main.listeners.size, 0, "超时后应清理监听器");
  console.log("[bili-sub] bridge self-test PASS: dual-world round trip, transport/bridge cache, URL validation, source/origin/id filters, safe runtime errors, correct network classification, timeout cleanup");
})().catch(error => { console.error(error); process.exitCode = 1; });
