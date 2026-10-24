const mode = "baseline";
const frames: number[] = [];
const tasks: { start: number; duration: number }[] = [];
let wheelTimes: number[] = [];
let scrollTimes: number[] = [];
let eventDelays: number[] = [];
let wheels: { t: number; delta: number; top: number }[] = [];
let positions: { t: number; top: number }[] = [];
let writes: { t: number; top: number; stack?: string }[] = [];
const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
Object.defineProperty(Element.prototype, "scrollTop", {
  ...scrollTopDescriptor,
  set(value: number) {
    if (this === target) writes.push({ t: performance.now(), top: value, stack: new Error().stack });
    scrollTopDescriptor.set!.call(this, value);
  },
});
let last = 0;
let until = 0;
let raf = 0;
let timer = 0;
let target: Element | null = null;
let startTop = 0;
const send = (data: unknown) => void fetch("http://127.0.0.1:43199", {
  method: "POST", body: JSON.stringify(data), mode: "no-cors",
});
const observer = new PerformanceObserver(list => {
  for (const e of list.getEntries()) tasks.push({ start: e.startTime, duration: e.duration });
});
observer.observe({ type: "longtask" });
const animationObserver = new PerformanceObserver(list => {
  for (const entry of list.getEntries()) send({ mode, animationFrame: entry.toJSON() });
});
animationObserver.observe({ type: "long-animation-frame", buffered: false });
const report = () => {
  const sorted = [...frames].sort((a, b) => a - b);
  send({ mode, target: target?.className, nodes: document.querySelectorAll("*").length,
    startTop, endTop: target?.scrollTop, wheelTimes, scrollTimes, eventDelays,
    frameCount: frames.length, p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1),
    slowFrames: frames.filter(t => t > 34), tasks: tasks.filter(t => t.start >= wheelTimes[0] - 100), wheels, positions, writes,
  });
  frames.length = 0; tasks.length = 0; wheelTimes = []; scrollTimes = []; eventDelays = [];
  wheels = []; positions = []; writes = [];
};
const frame = (t: number) => {
  if (last && t < until) frames.push(t - last);
  last = t;
  raf = requestAnimationFrame(frame);
};
const wheel = (e: WheelEvent) => {
  if (!wheelTimes.length) {
    target = e.target as Element | null;
    while (target && !(target.scrollHeight > target.clientHeight && /auto|scroll/.test(getComputedStyle(target).overflowY))) target = target.parentElement;
    startTop = target?.scrollTop ?? 0;
  }
  wheelTimes.push(performance.now());
  eventDelays.push(performance.now() - e.timeStamp);
  wheels.push({ t: performance.now(), delta: e.deltaY, top: target?.scrollTop ?? 0 });
  until = performance.now() + 1000;
  clearTimeout(timer);
  timer = window.setTimeout(report, 1500);
};
const scroll = (e: Event) => {
  const currentTarget = target;
  if (e.target === currentTarget && currentTarget) {
    scrollTimes.push(performance.now());
    positions.push({ t: performance.now(), top: currentTarget.scrollTop });
  }
};
document.addEventListener("wheel", wheel, { capture: true, passive: true });
document.addEventListener("scroll", scroll, { capture: true, passive: true });
raf = requestAnimationFrame(frame);
send({ mode, ready: true });
import.meta.hot?.accept();
import.meta.hot?.dispose(() => {
  animationObserver.disconnect();
  Object.defineProperty(Element.prototype, "scrollTop", scrollTopDescriptor);
  cancelAnimationFrame(raf); clearTimeout(timer); observer.disconnect();
  document.removeEventListener("wheel", wheel, true); document.removeEventListener("scroll", scroll, true);
});
