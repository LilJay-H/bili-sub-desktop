const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('一键安装器会复用安全登记脚本并打开扩展管理页', () => {
  const launcher = fs.readFileSync('一键安装器.ps1', 'utf8');
  const cmd = fs.readFileSync('一键安装器.cmd', 'utf8');
  const tutorial = fs.readFileSync('请先看教程-一键安装与使用.html', 'utf8');
  assert.match(launcher, /native\\Install\.ps1/);
  assert.match(launcher, /chrome:\/\/extensions\//);
  assert.match(launcher, /edge:\/\/extensions\//);
  assert.doesNotMatch(launcher, /Read-Host|document\.cookie|SESSDATA|bili_jct/);
  assert.match(cmd, /%~dpn0\.ps1/);
  assert.match(tutorial, /一键安装器\.cmd/);
  assert.match(tutorial, /加载已解压的扩展程序/);
  assert.match(tutorial, /不需要填写 ID/);
});

test('Windows 入口固定为 ASCII + CRLF，中文 PowerShell 使用 UTF-8 BOM', () => {
  for (const name of ['一键安装器.cmd', 'native/Install.cmd', 'native/Uninstall.cmd']) {
    const bytes = fs.readFileSync(name);
    assert.ok(bytes.every(b => b < 128), name);
    assert.doesNotMatch(bytes.toString(), /(?<!\r)\n/, name);
  }
  for (const name of ['一键安装器.ps1', 'native/Install.ps1', 'native/Build.ps1', 'native/Uninstall.ps1']) {
    assert.deepEqual([...fs.readFileSync(name).subarray(0, 3)], [239, 187, 191], name);
  }
});

// 用实际 cmd.exe → Windows PowerShell 5 执行入口；只模拟注册表和启动浏览器的副作用。
function runEntry(scenario, codepage) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-sub-entry-'));
  const dir = path.join(temp, '中文 安装目录');
  const packageDir = path.join(dir, 'package');
  fs.mkdirSync(path.join(packageDir, 'native'), {recursive:true});
  try {
    fs.copyFileSync('一键安装器.cmd', path.join(dir, '一键安装器.cmd'));
    fs.copyFileSync('一键安装器.ps1', path.join(packageDir, '一键安装器.ps1'));
    fs.copyFileSync('native/Install.ps1', path.join(packageDir, 'native/Install.ps1'));
    fs.writeFileSync(path.join(packageDir, 'native/BiliSubDesktop.exe'), 'test placeholder');
    const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    if (scenario === 'bad-key') manifest.key = 'invalid';
    fs.writeFileSync(path.join(packageDir, 'manifest.json'), JSON.stringify(manifest));
    const shim = `
$ErrorActionPreference='Stop'
$global:keys=@(); $global:opened=@(); $failed=$false
function New-Item { param($Path,[switch]$Force) $global:keys+= $Path }
function Set-Item { param($Path,$Value) }
function Get-Process {
 param($Name,$ErrorAction)
 if ($env:BILI_ENTRY_SCENARIO -in @('chrome','open-fails','bad-key') -and $Name -eq 'chrome') { [pscustomobject]@{Path='C:\\Test Browser\\chrome.exe'} }
}
function Test-Path {
 param($LiteralPath)
 if ($LiteralPath -match '(chrome|msedge)\\.exe$') {
   return ($env:BILI_ENTRY_SCENARIO -eq 'edge-x86' -and $LiteralPath -eq (Join-Path \${env:ProgramFiles(x86)} 'Microsoft\\Edge\\Application\\msedge.exe'))
 }
 Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath
}
function Start-Process {
 param($FilePath,$ArgumentList)
 if($env:BILI_ENTRY_SCENARIO -eq 'open-fails'){throw 'simulated browser launch failure'}
 $global:opened+=@{file=$FilePath;args=$ArgumentList}
}
try { & (Join-Path $PSScriptRoot 'package/一键安装器.ps1') }
catch { $failed=$true; Write-Host '入口执行失败' }
@{keys=$global:keys;opened=$global:opened;failed=$failed;psMajor=$PSVersionTable.PSVersion.Major}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $PSScriptRoot 'result.json') -Encoding UTF8
if($failed){exit 1}
`;
    fs.writeFileSync(path.join(dir, '一键安装器.ps1'), '\ufeff' + shim.replace(/\r?\n/g,'\r\n'));
    const run = spawnSync('cmd.exe', ['/d','/s','/c', `chcp ${codepage}>nul & call "${path.join(dir,'一键安装器.cmd')}" --no-pause`], {
      encoding:'utf8', windowsHide:true, windowsVerbatimArguments:true, timeout:20000,
      env:{...process.env, BILI_ENTRY_SCENARIO:scenario}
    });
    assert.ifError(run.error);
    assert.ok(fs.existsSync(path.join(dir,'result.json')), run.stdout+run.stderr);
    const result = JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8').replace(/^\ufeff/,''));
    return {status:run.status, output:run.stdout+run.stderr, ...result,
      hostWritten:fs.existsSync(path.join(packageDir,'native/com.bilisub.desktop.json'))};
  } finally {
    if(path.dirname(temp)===path.resolve(os.tmpdir()) && path.basename(temp).startsWith('bili-sub-entry-')) fs.rmSync(temp,{recursive:true,force:true});
  }
}

test('真实 CMD 在中文空格路径、936/437/65001 代码页下成功登记并显示中文', {skip:process.platform!=='win32'}, () => {
  for(const cp of [936,437,65001]) {
    const result=runEntry('chrome', cp);
    assert.equal(result.status,0,result.output);
    assert.equal(result.psMajor,5);
    assert.equal(result.keys.length,2);
    assert.equal(result.hostWritten,true);
    assert.equal(result.opened[0].args,'chrome://extensions/');
    assert.match(result.output,/桌面助手已安装/);
    assert.doesNotMatch(result.output,/不是内部|not recognized|�/);
  }
});

test('安装入口处理 Edge x86、浏览器打开失败及登记失败', {skip:process.platform!=='win32'}, () => {
  const edge=runEntry('edge-x86',936);
  assert.equal(edge.status,0,edge.output);
  assert.equal(edge.opened[0].args,'edge://extensions/');
  const browserFailure=runEntry('open-fails',936);
  assert.equal(browserFailure.status,0,browserFailure.output);
  assert.match(browserFailure.output,/请手动打开/);
  const badKey=runEntry('bad-key',936);
  assert.equal(badKey.status,1,badKey.output);
  assert.equal(badKey.keys.length,0);
  assert.equal(badKey.opened.length,0);
  assert.equal(badKey.hostWritten,false);
  assert.doesNotMatch(badKey.output,/桌面助手已安装/);
});
