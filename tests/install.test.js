// 用真实 Windows PowerShell 5 与模拟注册表验证安装器，不登记用户机器。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const original=JSON.parse(fs.readFileSync('manifest.json','utf8'));
const keyBytes=Buffer.from(original.key,'base64');
const fixedId=crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0,32).replace(/[0-9a-f]/g,n=>String.fromCharCode(97+parseInt(n,16)));
const fixedOrigin=`chrome-extension://${fixedId}/`;
const windows={skip:process.platform!=='win32'};

function runInstaller(manifest=original,previous){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-sub-install-test-'));
  const nativeDir=path.join(dir,'native');fs.mkdirSync(nativeDir);
  const hostPath=path.join(nativeDir,'com.bilisub.desktop.json');
  try{
    fs.copyFileSync('native/Install.ps1',path.join(nativeDir,'Install.ps1'));
    fs.writeFileSync(path.join(nativeDir,'BiliSubDesktop.exe'),'test-placeholder');
    fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
    if(previous!==undefined)fs.writeFileSync(hostPath,typeof previous==='string'?previous:JSON.stringify(previous));
    const before=fs.existsSync(hostPath)?fs.readFileSync(hostPath,'utf8'):null;
    const script=`
      $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
      $global:biliInstallKeys=@();$global:biliInstallValues=@();$global:biliInstallReads=0
      function New-Item {param([string]$Path,[switch]$Force) $global:biliInstallKeys+=$Path}
      function Set-Item {param([string]$Path,[string]$Value) $global:biliInstallValues+=@{path=$Path;value=$Value}}
      function Read-Host { $global:biliInstallReads++; throw 'Installation must not prompt' }
      function Write-Host {param($Object)}
      $failure=$null
      try { & (Join-Path $env:BILI_SUB_INSTALL_TEST_DIR 'native/Install.ps1') } catch { $failure=$_.Exception.Message }
      $data=$null;$hostPath=Join-Path $env:BILI_SUB_INSTALL_TEST_DIR 'native/com.bilisub.desktop.json'
      if(Test-Path -LiteralPath $hostPath){try{$data=Get-Content -LiteralPath $hostPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{}}
      @{keys=$global:biliInstallKeys;values=$global:biliInstallValues;manifest=$data;error=$failure;prompts=$global:biliInstallReads;psMajor=$PSVersionTable.PSVersion.Major}|ConvertTo-Json -Depth 5 -Compress
    `;
    const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
      {windowsHide:true,encoding:'utf8',env:{...process.env,BILI_SUB_INSTALL_TEST_DIR:dir},timeout:15000}));
    return {...result,dir,nativeDir,before,after:fs.existsSync(hostPath)?fs.readFileSync(hostPath,'utf8'):null};
  }finally{
    if(path.dirname(dir)===path.resolve(os.tmpdir()) && path.basename(dir).startsWith('bili-sub-install-test-'))fs.rmSync(dir,{recursive:true,force:true});
  }
}

test('manifest 固定公钥为 RSA-2048 SPKI，独立计算扩展 ID',()=>{
  const key=crypto.createPublicKey({key:keyBytes,format:'der',type:'spki'});
  assert.equal(key.asymmetricKeyType,'rsa');assert.equal(key.asymmetricKeyDetails.modulusLength,2048);
  assert.equal(key.asymmetricKeyDetails.publicExponent,65537n);
  assert.match(fixedId,/^[a-p]{32}$/);assert.equal(original.version,'0.6.2');
  const installer=fs.readFileSync('native/Install.ps1');assert.deepEqual([...installer.subarray(0,3)],[239,187,191],'Windows PS5 中文脚本须带 UTF8 BOM');
  assert.ok(!installer.toString('utf8').includes('Read-Host'));
});

test('PS5 安装无需输入，固定 ID 与 Node 一致，移动目录不变（模拟 HKCU）',windows,()=>{
  const first=runInstaller(),second=runInstaller();
  for(const result of [first,second]){
    assert.equal(result.psMajor,5);assert.equal(result.error,null);assert.equal(result.prompts,0);
    assert.deepEqual(result.keys,['HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.bilisub.desktop','HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.bilisub.desktop']);
    assert.equal(result.manifest.name,'com.bilisub.desktop');assert.equal(result.manifest.type,'stdio');
    assert.equal(result.manifest.path,path.join(result.nativeDir,'BiliSubDesktop.exe'));
    assert.deepEqual(result.manifest.allowed_origins,[fixedOrigin]);assert.equal(result.values.length,2);
    for(const value of result.values)assert.equal(value.value,path.join(result.nativeDir,'com.bilisub.desktop.json'));
  }
  assert.notEqual(first.dir,second.dir);
});

test('缺失或损坏公钥先失败，不写宿主清单或注册表',windows,()=>{
  for(const key of [undefined,'not base64!',Buffer.from('not a public key').toString('base64'),Buffer.alloc(294).toString('base64')]){
    const previous={name:'com.bilisub.desktop',allowed_origins:[`chrome-extension://${'a'.repeat(32)}/`]};
    const result=runInstaller({...original,key},previous);
    assert.ok(result.error);assert.equal(result.prompts,0);assert.deepEqual(result.keys,[]);assert.deepEqual(result.values,[]);
    assert.equal(result.after,result.before,'错误 key 不可覆盖已有本工具宿主配置');
  }
});

test('只兼容本工具清单中最多两个严格合法旧 ID，去重且拒绝通配符与尾换行',windows,()=>{
  const a=`chrome-extension://${'a'.repeat(32)}/`,b=`chrome-extension://${'b'.repeat(32)}/`,c=`chrome-extension://${'c'.repeat(32)}/`;
  const result=runInstaller(original,{name:'com.bilisub.desktop',allowed_origins:[
    'chrome-extension://*/',`chrome-extension://${'A'.repeat(32)}/`,a+'\n',a+'evil',`https://${'a'.repeat(32)}/`,7,
    fixedOrigin,a,a,b,c
  ]});
  assert.equal(result.error,null);assert.deepEqual(result.manifest.allowed_origins,[fixedOrigin,a,b]);
  const wrongName=runInstaller(original,{name:'other.host',allowed_origins:[a]});
  assert.deepEqual(wrongName.manifest.allowed_origins,[fixedOrigin]);
  const malformed=runInstaller(original,'not-json');assert.equal(malformed.error,null);assert.deepEqual(malformed.manifest.allowed_origins,[fixedOrigin]);
});
