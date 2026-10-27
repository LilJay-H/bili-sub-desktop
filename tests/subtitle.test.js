/* 最小离线自测：不会连接 B 站，也不会读取浏览器资料。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../content/subtitle.js"), "utf8");

function setup(options = {}) {
  let info = { bvid: "BVexample", aid: 123, cid: 456, page: 1 };
  const responses = new Map();
  const logs = [];
  let requests = 0;
  class XHR {
    open() {}
    send() {}
    addEventListener(name, handler) { this.handler = handler; }
  }
  const window = {
    BiliSub: {
      player: { getVideoInfo: () => info },
      fetchSubtitle: async url => {
        requests++;
        if (options.fail) throw new Error(options.fail);
        return options.payload || { body: [{ from: 1, to: 2, content: "测试" }] };
      }
    },
    fetch: async url => {
      const payload = responses.get(String(url));
      return { ok: true, json: async () => payload, clone() { return this; } };
    }
  };
  const context = {
    window, XMLHttpRequest: XHR, URL, location: { href: "https://www.bilibili.com/video/BVexample/" },
    document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    console: { info: (...values) => logs.push(values) }, setTimeout, clearTimeout
  };
  vm.runInNewContext(source, context);
  async function captureList(subtitles, code = 0, cid = 456) {
    const url = `https://api.bilibili.com/x/player/wbi/v2?aid=123&cid=${cid}`;
    responses.set(url, { code, data: { subtitle: { subtitles } } });
    const response = await window.fetch(url);
    await response.json();
    await new Promise(resolve => setImmediate(resolve));
    return response;
  }
  return { api: window.BiliSub.subtitle, window, responses, logs, captureList, setInfo: value => { info = value; }, count: () => requests, context };
}

const sub = (lan = "zh-CN", suffix = "manual") => ({ lan, ai_type: 0,
  subtitle_url: `//aisubtitle.hdslb.com/bfs/${lan.startsWith("ai-") ? "ai_subtitle" : "subtitle"}/${suffix}.json` });

test("自然响应不变，优先人工中文，规范化并排序；并发调用只下载一次", async () => {
  const app = setup({ payload: { body: [
    { from: 3, to: 4, content: " 后句 " }, { from: 1, to: 2, content: "<b>前句</b>" },
    { from: -1, to: 3, content: "无效" }, { from: 6, to: 5, content: "无效" }, { from: 5, to: 6, content: "" }
  ] } });
  const response = await app.captureList([sub("ai-zh", "ai"), sub("en", "english"), sub()]);
  assert.equal((await response.json()).code, 0);
  const [a, b] = await Promise.all([app.api.getSubtitles(), app.api.getSubtitles()]);
  assert.equal(a, b);
  assert.equal(a.lang, "zh-CN");
  assert.equal(a.source, "api");
  assert.equal(a.cues.length, 2);
  assert.equal(a.cues[0].text, "<b>前句</b>");
  assert.equal(a.cues[0].start, 1);
  await app.api.getSubtitles();
  assert.equal(app.count(), 1);
  assert.ok(!JSON.stringify(app.logs).includes("https://"));
});

test("播放器已下载的字幕 JSON 直接复用，不额外下载", async () => {
  const app = setup();
  const item = sub("ai-zh", "auto");
  const url = "https:" + item.subtitle_url;
  app.responses.set(url, { body: [{ from: 0, to: 3, content: "AI 字幕" }] });
  await app.window.fetch(url);
  await app.captureList([item]);
  const result = await app.api.getSubtitles();
  assert.equal(result.source, "intercept");
  assert.equal(result.cues[0].text, "AI 字幕");
  assert.equal(app.count(), 0);
});

test("确认字幕列表为空时明确返回 DOM 降级状态", async () => {
  const app = setup();
  await app.captureList([]);
  const result = await app.api.getSubtitles();
  assert.equal(result.source, "dom");
  assert.equal(result.cues.length, 0);
  assert.match(app.api.getDiagnostics().message, /没有可用字幕/);
  assert.equal(app.count(), 0);
});

test("登录失效和风控错误不尝试下载", async () => {
  for (const [code, message] of [[-101, /需要登录/], [-352, /安全验证/]]) {
    const app = setup();
    await app.captureList(null, code);
    await assert.rejects(app.api.getSubtitles(), message);
    assert.equal(app.count(), 0);
  }
});

test("切换分P读取新 cid 字幕，不复用上一P", async () => {
  const app = setup();
  await app.captureList([sub()]);
  const first = await app.api.getSubtitles();
  app.setInfo({ bvid: "BVexample", aid: 123, cid: 789, page: 2 });
  await app.captureList([sub("ai-zh", "part2")], 0, 789);
  const second = await app.api.getSubtitles();
  assert.equal(first.lang, "zh-CN");
  assert.equal(second.lang, "ai-zh");
  assert.equal(app.count(), 2);
});

test("不完整DOM和订阅取消不会抛错", () => {
  const app = setup();
  const received = [];
  const stop = app.api.onCurrentLine(text => received.push(text));
  assert.equal(typeof stop, "function");
  stop();
  assert.deepEqual(received, [""]);
});

test("晚注入仅重放已有且 cid 匹配的接口，仍然缓存结果", async () => {
  const app = setup();
  const observed = "https://api.bilibili.com/x/player/wbi/v2?aid=123&cid=456";
  app.responses.set(observed, { code: 0, data: { subtitle: { subtitles: [sub()] } } });
  app.window.performance = { getEntriesByType: () => [
    { name: "https://example.invalid/x/player/wbi/v2?cid=456" },
    { name: "https://api.bilibili.com/x/player/wbi/v2?cid=999" },
    { name: observed }
  ] };
  const result = await app.api.getSubtitles();
  assert.equal(result.cues.length, 1);
  await app.api.getSubtitles();
  assert.equal(app.count(), 1);
  assert.equal(app.logs.filter(item => item[0].includes("重放")).length, 1);
});

test("文件请求异常不会将原始地址带到日志或状态", async () => {
  const app = setup({ fail: "网络 https://example.invalid/private-query" });
  await app.captureList([sub()]);
  const result = await app.api.getSubtitles();
  assert.equal(result.source, "dom");
  assert.ok(!JSON.stringify(app.logs).includes("private-query"));
  assert.ok(!app.api.getDiagnostics().message.includes("https://"));
});

test("实际 AI 路径和 ai_type=0：六语言中优先 ai-zh 并复用自然请求", async () => {
  const app = setup();
  const items = ["ai-en", "ai-ja", "ai-ko", "ai-zh", "ai-es", "ai-fr"].map(lang => sub(lang, lang));
  const selectedUrl = "https:" + items[3].subtitle_url;
  app.responses.set(selectedUrl, { body: [{ from: 0, to: 1, content: "人工智能字幕" }] });
  await app.window.fetch(selectedUrl);
  await app.captureList(items);
  const result = await app.api.getSubtitles();
  assert.equal(result.lang, "ai-zh");
  assert.equal(result.source, "intercept");
  assert.match(app.api.getDiagnostics().message, /AI/);
  assert.equal(app.count(), 0);
});

test("AI 新路径只旁路观察精确的 aisubtitle 域名", async () => {
  const app = setup();
  const item = { lan: "ai-zh", subtitle_url: "//other.hdslb.com/bfs/ai_subtitle/other.json" };
  app.responses.set("https:" + item.subtitle_url, { body: [{ from: 0, to: 1, content: "不应拦截" }] });
  await app.window.fetch("https:" + item.subtitle_url);
  await app.captureList([item]);
  const result = await app.api.getSubtitles();
  assert.equal(result.source, "api");
  assert.equal(app.count(), 1);
});

test("启动时视频标识未就绪，补齐 cid 后复用同一请求", async () => {
  const app = setup();
  app.setInfo({ page: 1, cid: null });
  const first = app.api.getSubtitles();
  app.setInfo({ bvid: "BVexample", aid: 123, cid: 456, page: 1 });
  const second = app.api.getSubtitles();
  assert.equal(first, second);
  await app.captureList([sub("ai-zh", "ready")]);
  const result = await first;
  assert.equal(result.lang, "ai-zh");
  assert.equal(await app.api.getSubtitles(), result);
  assert.equal(app.count(), 1);
});

test("同一个 cid 更换页面入口仍复用字幕缓存", async () => {
  const app = setup();
  await app.captureList([sub()]);
  const first = await app.api.getSubtitles();
  app.context.location.href = "https://www.bilibili.com/zh-Hans/video/av123/";
  app.setInfo({ aid: 123, cid: 456, page: 1 });
  assert.equal(await app.api.getSubtitles(), first);
  assert.equal(app.count(), 1);
});

test("A有字幕到B无字幕再回A：缓存结果保留自己的诊断快照", async () => {
  const app = setup();
  await app.captureList([sub("ai-zh", "videoA")]);
  const resultA = await app.api.getSubtitles();
  app.setInfo({ bvid: "BVexample", aid: 123, cid: 789, page: 2 });
  await app.captureList([], 0, 789);
  const resultB = await app.api.getSubtitles();
  assert.match(app.api.getDiagnostics().message, /没有可用字幕/);
  app.setInfo({ bvid: "BVexample", aid: 123, cid: 456, page: 1 });
  const cachedA = await app.api.getSubtitles();
  assert.equal(cachedA, resultA);
  assert.equal(app.api.getDiagnostics(cachedA).source, "api");
  assert.equal(app.api.getDiagnostics(cachedA).count, 1);
  assert.match(app.api.getDiagnostics(cachedA).message, /已载入 AI 字幕/);
  assert.match(app.api.getDiagnostics(resultB).message, /没有可用字幕/);
  const externalCopy = app.api.getDiagnostics(cachedA);
  externalCopy.message = "修改外部副本";
  assert.match(app.api.getDiagnostics(cachedA).message, /已载入 AI 字幕/);
  assert.equal(app.count(), 1);
});
