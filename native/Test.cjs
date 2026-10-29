// 独立离屏进程，不连接浏览器、不截图桌面、不注册宿主。
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
const exe=path.join(__dirname,'BiliSubDesktop.exe');
const evidence=path.resolve(process.argv[2]||path.join(__dirname,'../evidence/v0.7.1'));
const frame=value=>{const body=Buffer.from(JSON.stringify(value),'utf8'),head=Buffer.alloc(4);head.writeUInt32LE(body.length);return Buffer.concat([head,body]);};
async function render(){
  const child=spawn(exe,['--self-test',evidence],{windowsHide:true,stdio:'ignore'});
  const timeout=setTimeout(()=>child.kill(),15000);
  try {assert.equal(await new Promise((r,j)=>{child.on('error',j);child.on('exit',r)}),0,'native rendering self-test');}
  finally {clearTimeout(timeout);child.kill();}
}
async function protocol(){
  const child=spawn(exe,['--protocol-test'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let bytes=Buffer.alloc(0),stderr='',messages=[];
  child.stderr.on('data',b=>stderr+=b.toString());
  const timeout=setTimeout(()=>child.kill(),15000);
  try {
    await new Promise((resolve,reject)=>{
      child.on('error',reject);
      child.stdout.on('data',chunk=>{
        try {
          bytes=Buffer.concat([bytes,chunk]);
          while(bytes.length>=4){const length=bytes.readUInt32LE();assert.ok(length>0&&length<=1048576);if(bytes.length<length+4)break;
            const message=JSON.parse(bytes.subarray(4,length+4));bytes=bytes.subarray(length+4);messages.push(message.type);
            if(message.type==='ready'){
              const state=frame({type:'state',index:0,time:3,paused:true,source:'offline-test',transparency:100,captionOpacity:90,layout:'flow',cues:[{start:0,end:10,text:'原生消息分片协议测试'}]});
              child.stdin.write(state.subarray(0,2));child.stdin.write(state.subarray(2,11));child.stdin.write(state.subarray(11));
              child.stdin.write(frame({type:'unsupported'}));
              child.stdin.write(frame({type:'close'}));
            }
          }
        }catch(e){reject(e);child.kill();}
      });
      child.on('exit',code=>{try{assert.equal(code,0);assert.deepEqual(messages,['ready','closed']);assert.equal(stderr,'');resolve();}catch(e){reject(e);}});
    });
  }finally{clearTimeout(timeout);child.kill();}
  await fs.writeFile(path.join(evidence,'native-protocol-checks.json'),JSON.stringify({kind:'native-stdio-loopback',checks:['ready frame','split length and UTF-8 body','state accepted','unknown type ignored','close and closed frame','clean exit, no protocol leakage'],messages},null,2));
}
(async()=>{await render();await protocol();console.log('[bili-sub] native PASS: layered/topmost, fitted caption plates, independent opacity, same text color, accent underline, long cue, rate/layout regression, framed protocol');})().catch(e=>{console.error(e);process.exitCode=1});
