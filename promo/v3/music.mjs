// Original instrumental score: 128 BPM, F# minor / D / A / E.
// All sounds are synthesized here; no speech, vocals, or licensed samples.
import {writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const SR=44100,DUR=90,N=SR*DUR,B=60/128,TAU=Math.PI*2;
const L=new Float32Array(N),R=new Float32Array(N);
let seed=12873;function rand(){seed=(seed*1664525+1013904223)>>>0;return seed/2147483648-1;}
const freq=m=>440*2**((m-69)/12);
function add(at,dur,fn,gain=1,pan=0){const start=Math.round(at*SR),len=Math.min(Math.round(dur*SR),N-start);for(let i=0;i<len;i++){if(start+i<0)continue;const s=fn(i/SR,i)*gain;L[start+i]+=s*Math.sqrt((1-pan)/2);R[start+i]+=s*Math.sqrt((1+pan)/2);}}
function kick(t,g=1){add(t,.43,x=>Math.sin(TAU*(46*x+6.2*(1-Math.exp(-x*32))))*Math.exp(-x*12)+rand()*.07*Math.exp(-x*120),.78*g);}
function clap(t,g=1){let lp=0;add(t,.23,x=>{const n=rand();lp+=.14*(n-lp);return ((n-lp)*.8+Math.sin(TAU*185*x)*.2)*Math.exp(-x*20)*(1+.55*Math.cos(x*TAU*95));},.33*g);}
function hat(t,g=.15,open=false,pan=0){let lp=0;add(t,open?.25:.065,x=>{const n=rand();lp+=.3*(n-lp);return (n-lp)*Math.exp(-x*(open?16:65));},g,pan);}
function bass(t,m,dur=.28,g=.3){const f=freq(m);add(t,dur,x=>{const env=Math.min(x/.008,1)*Math.min((dur-x)/.035,1)*Math.exp(-x*2);return (Math.sin(TAU*f*x)+.25*Math.sin(TAU*f*2*x)+.11*Math.sin(TAU*f*3*x))*env;},g);}
function pluck(t,m,g=.12,pan=0){const f=freq(m);const fn=x=>(Math.sin(TAU*f*x)+.35*Math.sin(TAU*f*2*x)+.11*Math.sin(TAU*f*4*x))*Math.min(x/.004,1)*Math.exp(-x*9);add(t,.7,fn,g,pan);add(t+B*.75,.7,fn,g*.23,-pan);add(t+B*1.5,.7,fn,g*.1,pan);}
function chord(t,notes,dur,g=.045){notes.forEach((m,j)=>{const f=freq(m);add(t,dur,x=>{const env=Math.min(x/.3,1)*Math.min((dur-x)/.5,1);const duck=.42+.58*(1-Math.exp(-(x%B)*13));return (Math.sin(TAU*f*x)+.4*Math.sin(TAU*f*1.003*x)+.15*Math.sin(TAU*f*2*x))*env*duck;},g,(j-1)*.5);});}
function riser(at,dur){let lp=0;add(at,dur,x=>{const n=rand();lp+=(.025+.25*x/dur)*(n-lp);return lp*(x/dur)**2;},.32);}
function impact(at){add(at,1.2,x=>Math.sin(TAU*43*x)*Math.exp(-x*6),.47);let lp=0;add(at,.85,x=>{const n=rand();lp+=.12*(n-lp);return lp*Math.exp(-x*5);},.24);}
const progression=[[42,54,57,61],[38,50,54,57],[45,57,61,64],[40,52,56,59]];
for(let bar=0;bar*B*4<88;bar++){
 const t=bar*B*4,c=progression[Math.floor(bar/2)%4];
 const intro=t<5,breakdown=t>=44&&t<51,final=t>=76;
 const energy=intro?.45:breakdown?.48:final?1:.8;
 chord(t,c.slice(1),B*4+.25,intro?.037:.052);
 for(let beat=0;beat<4;beat++){
  const at=t+beat*B;if(at>=88)continue;
  if(!breakdown||beat===0||beat===2)kick(at,intro?.55:1);
  if(beat%2===1&&!intro)clap(at,energy);
  hat(at,.1*energy,false,-.28);hat(at+B*.5,.2*energy,true,.27);
  if(!intro&&!breakdown){hat(at+B*.25,.065,false,-.55);hat(at+B*.75,.095,false,.55);}
  bass(at+B*.5,c[0],B*.41,.34*energy);
  if(beat===3&&!intro)bass(at+B*.82,c[0]+12,B*.15,.2);
 }
 if(!intro){for(let s=0;s<8;s++){const m=c[1+(s%3)]+(s%4===3?12:0);pluck(t+s*B*.5+B*.25,m,breakdown?.05:.105+(final?.025:0),(s%2?1:-1)*.5);}}
 if(bar%4===3&&!intro&&!breakdown){for(let f=0;f<4;f++)clap(t+B*3+B*f*.25,.22+f*.09);}
}
// Distinct melodic hooks in creation and final chapters.
const hook=[73,76,78,80,78,76,73,71,69,73,76,78,76,73,71,69];
for(const begin of [21,29,60,76])hook.forEach((m,i)=>pluck(begin+i*B,m,.1,(i%3-1)*.3));
for(const cut of [5,13,21,29,36,44,52,60,68,76,84]){riser(cut-.8,.8);impact(cut);}
for(const t of [10.5,16.5,25,40,49,56,64.3,72]){pluck(t,85,.11,.15);pluck(t+.12,90,.08,-.15);}
chord(86,[54,57,61,66],4,.055);pluck(87.5,78,.15);pluck(88,85,.09);
let peak=0;for(let i=0;i<N;i++){const fade=Math.min(i/SR/.08,1)*Math.min((DUR-i/SR)/1.8,1);L[i]=Math.tanh(L[i]*1.15)*fade;R[i]=Math.tanh(R[i]*1.15)*fade;peak=Math.max(peak,Math.abs(L[i]),Math.abs(R[i]));}
const bytes=N*4,out=Buffer.alloc(44+bytes);out.write('RIFF');out.writeUInt32LE(36+bytes,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(2,22);out.writeUInt32LE(SR,24);out.writeUInt32LE(SR*4,28);out.writeUInt16LE(4,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(bytes,40);
for(let i=0;i<N;i++){out.writeInt16LE(Math.round(L[i]/peak*.89*32767),44+i*4);out.writeInt16LE(Math.round(R[i]/peak*.89*32767),46+i*4);}
const path=join(dirname(fileURLToPath(import.meta.url)),'out/music.wav');writeFileSync(path,out);console.log('Original instrumental score:',path,'128 BPM / 90s / stereo');
