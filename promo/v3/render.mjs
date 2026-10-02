import puppeteer from 'puppeteer-core';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,extname,resolve} from 'node:path';
import {once} from 'node:events';
import {duration} from './story.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const preview=process.argv.includes('--preview');
await mkdir(join(root,'v3/build'),{recursive:true});
await mkdir(join(root,'out/v3-check'),{recursive:true});
const mime={'.html':'text/html','.css':'text/css','.mjs':'text/javascript','.png':'image/png','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{try{const name=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!name.startsWith(root))throw Error('path');res.setHeader('Content-Type',mime[extname(name)]||'application/octet-stream');res.end(await readFile(name));}catch{res.writeHead(404);res.end();}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await puppeteer.launch({executablePath:process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--hide-scrollbars','--font-render-hinting=none'],defaultViewport:{width:1920,height:1080,deviceScaleFactor:1}});
try{
 const page=await browser.newPage();page.on('pageerror',e=>{throw e;});
 await page.goto(`http://127.0.0.1:${server.address().port}/v3/index.html?capture=1`,{waitUntil:'networkidle0'});
 await page.evaluate(()=>document.fonts.ready);
 const images=await page.evaluate(()=>[...document.images].map(x=>({src:x.src,ok:x.complete&&x.naturalWidth>0})));
 if(images.some(x=>!x.ok))throw Error(JSON.stringify(images));
 if(preview){for(const t of [3,10,20.5,27,36,43.5,53,59,65]){await page.evaluate(t=>window.renderFrame(t),t);await page.screenshot({path:join(root,`out/v3-check/t${t}.png`)});}console.log('Preview frames complete');}
 else{
  const ff=spawn('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','image2pipe','-framerate','30','-i','-','-an','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',join(root,'v3/build/video.mp4')],{stdio:['pipe','inherit','inherit']});
  const finished=once(ff,'exit');
  for(let frame=0;frame<duration*30;frame++){
   await page.evaluate(t=>window.renderFrame(t),frame/30);
   const buf=await page.screenshot({type:'jpeg',quality:94});
   if(!ff.stdin.write(buf))await once(ff.stdin,'drain');
   if(frame%150===0)console.log(`Rendered ${frame/30}s / ${duration}s`);
  }
  ff.stdin.end();const [code]=await finished;if(code!==0)throw Error('ffmpeg '+code);
  console.log('Video render complete');
 }
}finally{await browser.close();server.close();}
