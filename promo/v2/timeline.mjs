import {scenes,duration} from './story.mjs';
const clamp=x=>Math.max(0,Math.min(1,x));
const ease=x=>1-Math.pow(1-clamp(x),3);
const $=s=>document.querySelector(s);
const wave=$('#waveform');
for(let i=0;i<72;i++){const b=document.createElement('i');b.style.height=`${12+Math.abs(Math.sin(i*2.7)*Math.cos(i*.4))*38}px`;wave.append(b);}
const move=(s,y,a=1,x=0,extra='')=>{const el=$(s);el.style.opacity=clamp(a);el.style.transform=`translate(${x}px,${y}px) ${extra}`;};
window.renderFrame=t=>{
 const idx=scenes.findIndex(s=>t>=s.start&&t<s.end);const s=scenes[idx<0?scenes.length-1:idx],u=t-s.start,d=s.end-s.start;
 for(const item of scenes){const e=$('#'+item.id);e.style.opacity=item.id===s.id?clamp(u/.45):0;e.style.zIndex=item.id===s.id?2:0;}
 const light=['scatter','ask','music','reuse','end'].includes(s.id);
 document.documentElement.style.setProperty('--ink',light?'#2b4635':'#f3f0e6');
 document.documentElement.style.setProperty('--shadow',light?'none':'0 2px 12px #0009');
 $('#chapter').textContent=['今晚 / 22:48','线索，散在各处','从目标开始','把决定留给你','创意，被看见','让氛围，流动','下次，接着用','明天 / 09:00',''][idx]||'';
 $('#demo').style.opacity=s.id==='end'?0:.53;
 $('#subtitle').textContent=s.subtitle;$('#subtitle').style.opacity=clamp((u-.7)/.4)*clamp((d-u)/.35);
 $('#bottom-line').style.width=`${t/duration*1920}px`;
 const enter=(sel,delay=0,y=35)=>move(sel,(1-ease((u-delay)/1.15))*y,ease((u-delay)/.65));
 if(s.id==='night'){enter('.night-copy',.4);move('.desk',8*Math.sin(u/5),1,0,`rotate(${.7-u*.13}deg) scale(${1+u*.003})`);$('.clock span').style.opacity=.35+.3*Math.sin(u*3);}
 if(s.id==='scatter'){enter('#scatter .side-copy',.1);['.s1','.s2','.s3'].forEach((a,i)=>move(a,0,ease((u-i*.6)/.8),(1-ease((u-i*.6)/1.4))*110));}
 if(s.id==='ask'){enter('.ask-heading');enter('.workspace',.2);enter('.prompt',.8,15);enter('.response',2.5,16);enter('.progress-row',4.2,12);enter('.ready',6.2,10);}
 if(s.id==='decision'){enter('#decision .side-copy');move('.proposal',20*(1-ease(u/1.4)),1,0,`rotate(${1-u*.1}deg)`);enter('.recommend',.7,12);enter('.decision-grid',2.2,15);}
 if(s.id==='visual'){$('.hero-image').style.transform=`scale(${1.025+u*.0035}) translateX(${-u*1.4}px)`;enter('.campaign-title',.5,24);enter('.image-caption',3,20);}
 if(s.id==='music'){enter('#music .side-copy');move('.music-board',20*(1-ease(u/1.3)),1,0,`rotate(${-1+u*.08}deg)`);[...wave.children].forEach((b,i)=>{b.style.transform=`scaleY(${.55+.45*Math.abs(Math.sin(u*3+i*.52))})`;b.style.background=i/72<u/7?'#648451':'#c5d2b5';});}
 if(s.id==='reuse'){enter('.reuse-heading');enter('.recipe',.3);enter('.saved',1.5,8);enter('.flow-arrow',3,0);enter('.next',3.2);enter('.next-prompt',4.5,12);}
 if(s.id==='morning'){enter('.morning-copy');move('.deliverable',0,1,40*(1-ease(u/1.4)),`rotate(${-3+u*.2}deg)`);}
 if(s.id==='end'){enter('.end-content',.2,20);$('.end-orbit').style.transform=`scale(${1+u*.004})`;}
};
window.renderFrame(0);
if(!new URLSearchParams(location.search).has('capture')){const start=performance.now();function tick(){window.renderFrame(((performance.now()-start)/1000)%duration);requestAnimationFrame(tick)}requestAnimationFrame(tick);}
