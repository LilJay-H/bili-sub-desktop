// 主世界仅传递字幕与播放状态；连接本机程序由隔离世界和扩展后台负责。
(() => {
  'use strict';
  const ns = window.BiliSub = window.BiliSub || {};
  let player, handlers = {}, cues = [], time = 0, status = '', domLine = '', source = '';
  let appearance = {fontSize:18,transparency:100,captionOpacity:90,theme:'paper',layout:'flow',step:10};
  let active = false, pending = null, revision = 0, sentRevision = -1;
  let windowStart = 0, windowCues = [];
  const post = (action, payload) => window.postMessage({channel:'bili-sub-desktop-request',action,payload}, location.origin);
  function stop(error) {
    const wasActive = active; active = false;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(error || '桌面窗口已关闭。')); pending = null; }
    if (wasActive) handlers.onClose?.();
    if (error && wasActive) handlers.onError?.(error);
  }
  function sync() {
    if (!active || !player) return;
    let lo=0,hi=cues.length-1,anchor=-1;
    while(lo<=hi){const mid=(lo+hi)>>1;if(cues[mid].start<=time){anchor=mid;lo=mid+1;}else hi=mid-1;}
    // 消息始终小于 nativeMessaging 的 1 MiB 上限，不反复发送整段长访谈。
    const refresh=sentRevision!==revision || anchor<windowStart && (anchor>=0||windowStart>0) || anchor>=windowStart+windowCues.length-3 && windowStart+windowCues.length<cues.length;
    if(refresh){
      windowStart=Math.max(0,anchor-12);let total=0;windowCues=[];
      for(const cue of cues.slice(windowStart,Math.max(0,anchor)+36)){
        if(total+cue.text.length>90000)break;windowCues.push(cue);total+=cue.text.length;
      }
      sentRevision=revision;
    }
    const index=anchor>=windowStart && anchor-windowStart<windowCues.length && time<cues[anchor].end ? anchor-windowStart : -1;
    const duration=player.getDuration?.()||0;
    const payload={type:'state',time,duration,videoKey:String(player.getVideoInfo?.().key||'').slice(0,500),paused:!!player.isPaused(),rate:player.getRate(),...appearance,status:(domLine||status).slice(0,500),source:source.slice(0,500),index};
    if(refresh)payload.cues=windowCues;
    post('state',payload);
  }
  async function command(message) {
    if (!active) return;
    try {
      const n=Number(message.value);
      switch(message.action){
        case 'toggle': await player.toggle(); break;
        case 'seekBy': if(Number.isFinite(n)&&Math.abs(n)<=120)player.seekBy(n); break;
        case 'volumeBy': if(Number.isFinite(n)&&Math.abs(n)<=1)player.volumeBy(n); break;
        case 'seekTo': if(Number.isFinite(n)&&n>=0)player.seekTo(n); break;
        case 'setRate': if(Number.isFinite(n)&&n>=.25&&n<=4)player.setRate(n); break;
        case 'prev': await player.prev(); break;
        case 'next': await player.next(); break;
        case 'close': close(); return;
        case 'appearance':
          if (message.layout !== undefined && !['flow','lines'].includes(message.layout)) return;
          handlers.onAppearance?.(message); break;
        default: return;
      }
      time=player.getTime(); sync();
    } catch(error) { status=error?.message||'播放操作未完成，请检查视频页。'; sync(); handlers.onError?.(status); }
  }
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='bili-sub-desktop-response')return;
    const m=event.data.payload; if(!m || (!active&&!pending))return;
    if(m.type==='ready' && pending){
      const p=pending;pending=null;clearTimeout(p.timer);active=true;sentRevision=-1;
      handlers.onOpen?.();sync();p.resolve();
    } else if(m.type==='closed')stop();
    else if(m.type==='error')stop(String(m.message||'桌面字幕连接中断。'));
    else if(m.type==='command')command(m);
  });
  function open(){
    if(active)return Promise.resolve();
    if(pending)return pending.promise;
    let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
    const timer=setTimeout(()=>{post('close');stop('桌面助手没有响应。请双击 native/Install.cmd 完成免 ID 安装，再重试。');},10000);
    pending={promise,resolve,reject,timer};post('open');return promise;
  }
  function close(){post('close');stop();}
  ns.desktop={
    mount(api,callbacks){player=api;handlers=callbacks;},open,close,
    setCues(value){cues=value;revision++;domLine='';sync();},
    setCurrentTime(value){time=value;sync();},
    setStatus(value){status=value;sync();},
    setCurrentLine(value){domLine=value;sync();},
    setSource(value){source=value;sync();},
    setAppearance(value){
      if (value.layout !== undefined && !['flow','lines'].includes(value.layout)) return;
      appearance={...appearance,...value};sync();
    }
  };
})();
