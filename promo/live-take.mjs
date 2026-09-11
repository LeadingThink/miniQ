import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
const browser = await puppeteer.connect({browserURL:'http://127.0.0.1:19400',defaultViewport:null});
const pages = await browser.pages();
const desktop = pages.find(p=>p.url().includes('port=19300'));
const mobile = await browser.newPage();
await desktop.setViewport({width:1440,height:900,deviceScaleFactor:1});
await mobile.setViewport({width:430,height:900,deviceScaleFactor:1,isMobile:true,hasTouch:true});
await mobile.evaluateOnNewDocument(()=>{const O=window.WebSocket;window.WebSocket=class extends O{constructor(url,p){super(String(url).includes('miniq-relay/ws')?'ws://127.0.0.1:19200/ws':url,p)}}});
await mobile.goto('http://127.0.0.1:1420/');
const click = async (page,text) => page.evaluate(text=>{
 const el=[...document.querySelectorAll('button')].find(e=>e.innerText.trim()===text||e.getAttribute('aria-label')===text||e.title===text);
 if(!el) throw Error('Missing '+text); el.click();
},text);
try {await click(desktop,'关闭设置');} catch {}
try {await click(desktop,'隐藏侧栏');} catch {}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await mobile.evaluate(()=>{const O=window.WebSocket;window.WebSocket=class extends O{constructor(url,p){super('ws://127.0.0.1:19200/ws',p)}}});
const settings=JSON.parse(await readFile(`${process.env.HOME}/.local/share/miniq/settings.json`,'utf8'));
await mobile.type('input[type=password]',settings.provider.apiKey);
await click(mobile,'远程桌面\n同步桌面项目、任务进度、会话与待审批操作');await sleep(300);
await click(mobile,'连接桌面端');await sleep(1800);
console.log(await mobile.evaluate(()=>document.body.innerText));
await click(mobile,'显示侧栏');await sleep(300);
await mobile.evaluate(()=>[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')?.includes('创建 发布清单.md'))?.click());
await sleep(300);try{await click(mobile,'隐藏侧栏');}catch{}
const make = name => spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-framerate','4','-i','-','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p',`promo/out/live/${name}.mp4`],{stdio:['pipe','inherit','inherit']});
const d=make('take-desktop'), m=make('take-mobile');
let running=true, frame=0;
const events=[];
const mark = name=>{events.push({name,frame,time:frame/4});console.log(name,frame/4);};
const capture=(async()=>{while(running){const start=Date.now();
 for(const [p,ff] of [[desktop,d],[mobile,m]]) { const image=await p.screenshot({type:'jpeg',quality:90}); if(!ff.stdin.write(image)) await new Promise(r=>ff.stdin.once('drain',r)); }
 frame++; await sleep(Math.max(0,250-(Date.now()-start)));
}})();
try {
 await sleep(1500); mark('desktop-goal');
 await desktop.waitForFunction(()=>document.body.innerText.includes('允许一次'),{timeout:60000});
 await mobile.waitForFunction(()=>document.body.innerText.includes('允许一次'),{timeout:10000});
 mark('approval-ready'); await sleep(2500); await click(mobile,'允许一次'); mark('mobile-approve');
 await desktop.waitForFunction(()=>!document.body.innerText.includes('正在请求模型')&&!document.querySelector('button[title="停止并清空队列 (⌘.)"]'),{timeout:60000});
 await sleep(2000); mark('file-created');
 await mobile.type('textarea','继续：读取发布摘要，给出一句发布前提醒，不修改文件。',{delay:85});
 await click(mobile,'发送'); mark('mobile-send');
 await desktop.waitForFunction(()=>!document.querySelector('button[title="停止并清空队列 (⌘.)"]'),{timeout:60000});
 await sleep(3500); mark('completed');
 await writeFile('promo/out/live/transcript.json',JSON.stringify({desktop:await desktop.evaluate(()=>document.body.innerText),mobile:await mobile.evaluate(()=>document.body.innerText)},null,2));
} finally {
 running=false;await capture;
 const ends=[d,m].map(ff=>new Promise((resolve,reject)=>{ff.on('exit',code=>code===0?resolve():reject(Error('ffmpeg '+code)));ff.stdin.end();}));
 await Promise.all(ends);await writeFile('promo/out/live/events.json',JSON.stringify(events,null,2));browser.disconnect();
}
