const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('一键安装器会复用安全登记脚本并打开扩展管理页', () => {
  const launcher = fs.readFileSync('一键安装器.ps1', 'utf8');
  const cmd = fs.readFileSync('一键安装器.cmd', 'utf8');
  const tutorial = fs.readFileSync('请先看教程-一键安装与使用.html', 'utf8');
  assert.match(launcher, /native\\Install\.ps1/);
  assert.match(launcher, /chrome:\/\/extensions\//);
  assert.match(launcher, /edge:\/\/extensions\//);
  assert.doesNotMatch(launcher, /Read-Host|document\.cookie|SESSDATA|bili_jct/);
  assert.match(cmd, /一键安装器\.ps1/);
  assert.match(tutorial, /一键安装器\.cmd/);
  assert.match(tutorial, /加载已解压的扩展程序/);
  assert.match(tutorial, /不需要填写 ID/);
});
