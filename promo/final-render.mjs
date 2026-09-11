import puppeteer from 'puppeteer-core';
import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
process.chdir(root);
await mkdir('out/final',{recursive:true});
const run=args=>new Promise((resolve,reject)=>{const p=spawn('ffmpeg',['-y','-hide_banner','-loglevel','error',...args],{stdio:'inherit'});p.on('exit',c=>c===0?resolve():reject(Error('ffmpeg '+c)));});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const page=await browser.newPage();await page.setViewport({width:1920,height:1080});
const css=`body{margin:0;font-family:"PingFang SC",sans-serif;color:#f7f9fa;background:transparent}*{box-sizing:border-box}h1{font-size:48px;line-height:1.2;margin:0}p{font-size:27px;line-height:1.6;color:#b9c6c9}small{font-size:20px;color:#a4b3b8}.top{position:absolute;left:70px;top:24px}.tag{color:#64edbe;font-size:20px;margin-bottom:8px}.foot{position:absolute;bottom:20px;left:70px;font-size:22px;color:#b9c6c9}.brand{color:#64edbe}.line{height:4px;background:#64edbe;width:90px;margin:30px 0}`;
async function card(name,html,bg='transparent'){await page.setContent(`<style>${css}body{background:${bg}}</style>${html}`);await page.screenshot({path:`out/final/${name}.png`,omitBackground:true});}
await card('label','<div style="position:absolute;right:38px;top:26px;font-size:18px;color:#7b919a">功能动效演示</div>');
for(const [name,title,foot] of [['approve','电脑上的任务，手机上批准。','同一个 Key · 同一个桌面会话 · 手机点击「允许一次」'],['continue','离开电脑，工作继续。','手机发送续接指令 → 桌面读取文件并回复'],['done','一端操作，两端同步。','真实模型调用 · 真实文件写入与读取 · 已完成']])
 await card(name,`<div class="top"><div class="tag">miniQ / 真实产品实录 · 本地隔离 relay</div><h1>${title}</h1></div><div class="foot">${foot}</div>`);
await card('protocol',`<div style="position:absolute;left:80px;top:95px;width:1040px"><div class="tag">miniQ / 模型自由，协议可选</div><h1 style="font-size:66px">国内外模型，接入你的工作。</h1><div class="line"></div><p>GPT · Claude · Gemini · Grok<br>DeepSeek · GLM · Kimi</p><h1 style="font-size:34px;margin-top:40px">OpenAI Responses</h1><p>GPT / o / Codex 系列的协议选项</p><h1 style="font-size:34px">Anthropic Messages</h1><p>Claude 原生消息与工具调用</p><h1 style="font-size:34px">OpenAI Chat Completions</h1><p>兼容网关中的 Gemini / Grok / DeepSeek / GLM / Kimi 等</p><small>具体模型、工具与流式能力取决于服务商和网关。<br>本次实录通过 Chat Completions 完成，不代表所有渠道均已验证。</small></div><div style="position:absolute;right:185px;top:56px;font-size:23px;color:#64edbe">真实设置界面</div>`,'#101719');
await card('end','<div style="position:absolute;left:150px;top:230px"><div class="tag">YOUR LOCAL AI COWORKER</div><h1 style="font-size:150px">mini<span class="brand">Q</span></h1><div class="line"></div><h1 style="font-size:54px">从一句目标，到真正完成。</h1><p>本地工作 · 审批可控 · 手机续接</p></div>','#101719');
await browser.close();
const enc=['-r','30','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p'];
await run(['-i','out/miniq-promo.mp4','-i','out/final/label.png','-filter_complex','[0:v][1:v]overlay=0:0','-t','38',...enc,'out/final/intro.mp4']);
for(const [name,start,dur] of [['approve',0,11.25],['continue',11.25,5.75],['done',17,3]]){
 if(name==='done') {
 await run(['-f','lavfi','-i','color=c=0x101719:s=1920x1080:r=30','-loop','1','-i','out/live/completed-desktop.png','-loop','1','-i','out/live/completed-mobile.png','-i','out/final/done.png','-filter_complex','[1:v]scale=1280:800[d];[2:v]scale=400:838[m];[0:v][d]overlay=60:166[b];[b][m]overlay=1430:146[c];[c][3:v]overlay=0:0','-t','3',...enc,'out/final/done.mp4']);
 continue;
 }
 await run(['-f','lavfi','-i','color=c=0x101719:s=1920x1080:r=30','-i','out/live/take-desktop.mp4','-i','out/live/take-mobile.mp4','-i',`out/final/${name}.png`,'-filter_complex',`[1:v]tpad=stop_mode=clone:stop_duration=4,trim=start=${start}:duration=${dur},setpts=PTS-STARTPTS,scale=1280:800[d];[2:v]tpad=stop_mode=clone:stop_duration=4,trim=start=${start}:duration=${dur},setpts=PTS-STARTPTS,scale=400:838[m];[0:v][d]overlay=60:166[b];[b][m]overlay=1430:146[c];[c][3:v]overlay=0:0`,'-t',String(dur),...enc,`out/final/${name}.mp4`]);
}
await run(['-loop','1','-i','out/final/protocol.png','-i','out/live/protocol.mp4','-filter_complex','[1:v]scale=552:907[s];[0:v][s]overlay=1280:115','-t','14',...enc,'out/final/protocol.mp4']);
await run(['-loop','1','-i','out/final/end.png','-vf','fade=t=in:st=0:d=0.25,fade=t=out:st=5.5:d=0.5','-t','6',...enc,'out/final/end.mp4']);
const names=['intro','approve','continue','done','protocol','end'];
await run([...names.flatMap(n=>['-i',`out/final/${n}.mp4`]),'-i','out/audio.wav','-filter_complex',`${names.map((_,i)=>`[${i}:v]`).join('')}concat=n=6:v=1:a=0[v]`,'-map','[v]','-map','6:a','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-af','volume=-2dB','-c:a','aac','-b:a','192k','-t','78','-movflags','+faststart','out/miniq-promo-final.mp4']);
console.log('Finished out/miniq-promo-final.mp4');
