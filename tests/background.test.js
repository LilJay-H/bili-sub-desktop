"use strict";
// 无网络测试：在 VM 中模拟扩展消息与分块字幕响应。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const validUrl = "https://aisubtitle.hdslb.com/bfs/ai_subtitle/test.json";
const validSender = { id: "self-extension", frameId: 0, tab: { id: 7 }, url: "https://www.bilibili.com/video/BVtest/" };

function responseFor(value, options = {}) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
  const chunks = options.chunks || [bytes];
  let index = 0;
  const state = { cancelled: false, reads: 0 };
  return {
    response: {
      ok: options.ok !== false,
      headers: { get: () => options.length == null ? null : String(options.length) },
      body: { getReader: () => ({
        async read() { state.reads++; return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; },
        async cancel() { state.cancelled = true; }
      }) }
    },
    state
  };
}

function fixture(fetchImplementation) {
  let listener;
  const requests = [];
  const context = vm.createContext({
    chrome: { runtime: { id: "self-extension", onMessage: { addListener(callback) { listener = callback; } } } },
    URL, AbortSignal, Uint8Array, TextDecoder,
    async fetch(url, options) { requests.push({ url, options }); return fetchImplementation(url, options); }
  });
  vm.runInContext(source, context);
  return {
    requests,
    dispatch(message, sender = validSender) {
      return new Promise(resolve => {
        const returned = listener(message, sender, resolve);
        if (returned !== true && message.type !== "bili-sub-fetch") resolve({ ignored: true });
      });
    },
    fetch(url = validUrl, sender = validSender) { return this.dispatch({ type: "bili-sub-fetch", url }, sender); }
  };
}

(async () => {
  const validPayload = { body: [{ from: 1, to: 3, content: "字幕测试", ignoredField: "do-not-forward" }], ignoredTopLevel: true };
  const env = fixture(async () => responseFor(validPayload).response);
  for (const url of [
    "http://aisubtitle.hdslb.com/bfs/ai_subtitle/test.json",
    "https://aisubtitle.hdslb.com.evil.invalid/bfs/ai_subtitle/test.json",
    "https://evil.invalid/bfs/ai_subtitle/test.json",
    "https://aisubtitle.hdslb.com:8443/bfs/ai_subtitle/test.json",
    "https://user@aisubtitle.hdslb.com/bfs/ai_subtitle/test.json",
    "https://aisubtitle.hdslb.com/other/test.json",
    "https://aisubtitle.hdslb.com/bfs/ai_subtitle/../../other/test.json",
    "//aisubtitle.hdslb.com/bfs/ai_subtitle/test.json",
    "javascript:alert(1)", "invalid", null
  ]) {
    assert.equal((await env.fetch(url)).ok, false, "拒绝非白名单 URL");
  }
  assert.equal(env.requests.length, 0, "非法 URL 不应发出请求");
  for (const sender of [
    { ...validSender, id: "other-extension" },
    { ...validSender, frameId: 1 },
    { ...validSender, tab: undefined },
    { ...validSender, url: "https://www.bilibili.com.evil.invalid/video/BVtest/" },
    { ...validSender, url: "http://www.bilibili.com/video/BVtest/" },
    { ...validSender, url: "https://evil.invalid/" },
    { ...validSender, url: undefined }
  ]) assert.equal((await env.fetch(validUrl, sender)).ok, false, "拒绝非法发送者");
  assert.equal(env.requests.length, 0);
  assert.equal((await env.dispatch({ type: "unrelated" })).ignored, true);

  const results = await Promise.all([env.fetch(), env.fetch(), env.fetch()]);
  assert.equal(env.requests.length, 1, "并发请求必须只下载一次");
  assert.ok(results.every(result => result.ok));
  assert.equal(results[0].data.body[0].content, "字幕测试");
  assert.deepEqual(Object.keys(results[0].data), ["body"]);
  assert.deepEqual(Object.keys(results[0].data.body[0]), ["from", "to", "content"]);
  await env.fetch();
  assert.equal(env.requests.length, 1, "已完成结果必须命中缓存");
  assert.equal(env.requests[0].options.credentials, "omit");
  assert.equal(env.requests[0].options.redirect, "error");
  assert.ok(env.requests[0].options.signal instanceof AbortSignal);

  for (const badPayload of ["not-json", {}, { body: {} }, null, { body: [null] }]) {
    const bad = fixture(async () => responseFor(badPayload).response);
    const first = await bad.fetch();
    const second = await bad.fetch();
    assert.equal(first.ok, false, "格式错误应安全失败");
    assert.equal(second.ok, false);
    assert.equal(bad.requests.length, 1, "失败也必须缓存以防反复请求");
    assert.match(first.error, /字幕文件读取失败或超时/);
  }

  const headerLarge = responseFor(validPayload, { length: 8 * 1024 * 1024 + 1 });
  const headerEnv = fixture(async () => headerLarge.response);
  assert.equal((await headerEnv.fetch()).ok, false);
  assert.equal(headerLarge.state.reads, 0, "长度头过大应在读取前拒绝");
  const streamingLarge = responseFor("", { chunks: [new Uint8Array(4 * 1024 * 1024), new Uint8Array(4 * 1024 * 1024 + 1)] });
  const streamEnv = fixture(async () => streamingLarge.response);
  assert.equal((await streamEnv.fetch()).ok, false);
  assert.equal(streamingLarge.state.cancelled, true, "未知长度响应超限必须取消流");
  const httpError = fixture(async () => responseFor({}, { ok: false }).response);
  assert.equal((await httpError.fetch()).ok, false);
  const networkError = fixture(async () => { throw new Error("UNTRUSTED_EXCEPTION_MUST_NOT_ESCAPE"); });
  assert.equal((await networkError.fetch()).error.includes("UNTRUSTED"), false);
  console.log("[bili-sub] background self-test PASS: URL allowlist, sender validation, concurrent cache, omitted credentials, redirects blocked, format/size/network errors, safe error messages");
})().catch(error => { console.error(error); process.exitCode = 1; });
