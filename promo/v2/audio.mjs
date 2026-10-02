import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {scenes,duration} from './story.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
process.chdir(root);
await mkdir('build',{recursive:true});
await mkdir('assets/voice',{recursive:true});
const run=(cmd,args,capture=false)=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:capture?['ignore','pipe','inherit']:'inherit'});let out='';if(capture)p.stdout.on('data',b=>out+=b);p.on('error',reject);p.on('exit',c=>c===0?resolve(out):reject(Error(`${cmd}: ${c}`)));});
const reports=[];
for(let i=0;i<scenes.length;i++){
 const s=scenes[i];await writeFile(`assets/voice/${i}.txt`,s.vo);
 await run('say',['-v','Tingting','-r','165','-f',`assets/voice/${i}.txt`,'-o',`assets/voice/${i}.aiff`]);
 const raw=Number(await run('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',`assets/voice/${i}.aiff`],true));
 const slot=s.end-s.start-1.25;
 const tempo=Math.max(1,raw/slot);
 await run('ffmpeg',['-y','-hide_banner','-loglevel','error','-i',`assets/voice/${i}.aiff`,'-af',`atempo=${tempo.toFixed(5)},highpass=f=85,lowpass=f=9500,afade=t=in:d=0.035,afade=t=out:st=${Math.max(0,Math.min(raw,slot)-.12)}:d=0.1,loudnorm=I=-18:TP=-2:LRA=7`,'-ar','48000',`assets/voice/${i}.wav`]);
 reports.push({scene:s.id,start:s.start+.75,rawDuration:raw,tempo});
}
await writeFile('build/voice-timing.json',JSON.stringify(reports,null,2));
const inputs=['-i','assets/spring-music.wav',...scenes.flatMap((_,i)=>['-i',`assets/voice/${i}.wav`])];
const filters=[`[0:a]atrim=0:${duration},asetpts=PTS-STARTPTS,volume=0.13,afade=t=in:d=1.5,afade=t=out:st=63:d=5[music]`,...scenes.map((s,i)=>`[${i+1}:a]adelay=${(s.start+.75)*1000}:all=1[v${i}]`),`[music]${scenes.map((_,i)=>`[v${i}]`).join('')}amix=inputs=${scenes.length+1}:normalize=0,alimiter=limit=0.89,apad,atrim=0:${duration}[mix]`];
await run('ffmpeg',['-y','-hide_banner','-loglevel','error',...inputs,'-filter_complex',filters.join(';'),'-map','[mix]','-ar','48000','-ac','2','build/mix.wav']);
console.log('Narration and music mix complete');
