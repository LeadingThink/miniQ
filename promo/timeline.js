const DURATION = 55;
const GOAL = "把这个仓库整理成产品报告，并生成一份周报文档";

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeInOut = (t) => {
  t = clamp01(t);
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
};

const CUTS = [3.6, 8.4, 14.4, 19.8, 24.8, 29.4, 33.8, 38.0, 41.6];

const screens = {
  home: $("sc-home"),
  chat: $("sc-chat"),
  docs: $("sc-docs"),
  browser: $("sc-browser"),
  skill: $("sc-skill"),
  schedule: $("sc-schedule"),
  remote: $("sc-remote"),
};

function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) {
    el.classList.toggle("on", k === name);
  }
}

function setCopy({ kicker = "", title = "", sub = "", center = false, x, y } = {}) {
  const box = $("copy");
  $("kicker").textContent = kicker;
  $("title").innerHTML = title;
  $("sub").textContent = sub;
  box.classList.toggle("center", !!center);
  if (x != null) box.style.left = x + "px";
  else if (!center) box.style.left = "96px";
  if (y != null) box.style.top = y + "px";
  else if (!center) box.style.top = "140px";
}

function slamCopy(t, t0) {
  const u = easeOut((t - t0) / 0.32);
  const box = $("copy");
  box.style.opacity = String(u);
  box.style.filter = `blur(${(1 - u) * 12}px)`;
  box.style.transform = box.classList.contains("center")
    ? `translate(-50%,-50%) translateY(${(1 - u) * 36}px) scale(${1.16 - 0.16 * u})`
    : `translateY(${(1 - u) * 28}px) scale(${1.1 - 0.1 * u})`;
}

function fadeCopy(t, t1, dur = 0.18) {
  const u = clamp01((t1 - t) / dur);
  $("copy").style.opacity = String(Math.min(Number($("copy").style.opacity || 1), u));
}

function cam(el, { x = 0, y = 0, s = 1, ry = 0, rx = 0, blur = 0, op = 1 }) {
  el.style.opacity = String(op);
  el.style.filter = blur ? `blur(${blur}px)` : "none";
  el.style.transform = `translate(${x}px, ${y}px) perspective(1600px) rotateY(${ry}deg) rotateX(${rx}deg) scale(${s})`;
}

function mixCam(a, b, u) {
  const t = easeInOut(u);
  const out = {};
  for (const k of Object.keys(a)) out[k] = lerp(a[k] ?? 0, b[k] ?? 0, t);
  return out;
}

const CAM = {
  hidden: { x: 420, y: 80, s: 0.62, ry: -28, rx: 8, blur: 10, op: 0 },
  intro: { x: 260, y: 40, s: 0.78, ry: -18, rx: 6, blur: 0, op: 1 },
  type: { x: 220, y: 20, s: 0.86, ry: -10, rx: 3, blur: 0, op: 1 },
  tools: { x: 40, y: -10, s: 0.96, ry: -4, rx: 1, blur: 0, op: 1 },
  appr: { x: -20, y: -30, s: 1.08, ry: 0, rx: 0, blur: 0, op: 1 },
  docs: { x: -80, y: 10, s: 0.92, ry: 10, rx: 2, blur: 0, op: 1 },
  browser: { x: 10, y: -20, s: 1.0, ry: -6, rx: 0, blur: 0, op: 1 },
  skill: { x: 80, y: 0, s: 0.9, ry: -8, rx: 2, blur: 0, op: 1 },
  sched: { x: -40, y: 10, s: 0.94, ry: 8, rx: 1, blur: 0, op: 1 },
  remote: { x: 0, y: 20, s: 0.88, ry: 0, rx: 4, blur: 0, op: 1 },
  exit: { x: 0, y: 40, s: 0.7, ry: 0, rx: 6, blur: 8, op: 0 },
};

function typeText(el, full, t, t0, cps = 18) {
  const n = clamp(Math.floor((t - t0) * cps), 0, full.length);
  if (t < t0) {
    el.innerHTML = `<span class="ph">随心输入,Enter 发送,/ 引用技能</span>`;
    return 0;
  }
  const shown = full.slice(0, n);
  const caret = n < full.length ? `<span class="caret"></span>` : "";
  el.innerHTML = shown + caret;
  return n / full.length;
}

function setTools(t) {
  const steps = document.querySelectorAll("[data-tool]");
  const starts = [8.55, 9.45, 10.4, 11.45, 12.55];
  steps.forEach((el, i) => {
    const t0 = starts[i];
    const marker = el.querySelector(".tool-step-marker");
    const action = el.querySelector(".tool-action");
    if (t < t0) {
      el.style.display = "none";
      el.className = "tool-step";
      return;
    }
    el.style.display = "block";
    const done = t > t0 + 0.78;
    el.className = "tool-step " + (done ? "succeeded" : "running");
    if (done) {
      marker.textContent = "✓";
      action.textContent = el.dataset.done;
    } else {
      marker.innerHTML = `<span class="spin"></span>`;
      action.textContent = el.dataset.run;
    }
  });
}

function vis(el, on) {
  if (!el) return;
  el.style.display = on ? "" : "none";
}

function aimCursor(id, t, tMove, tClick) {
  const el = $(id);
  const cursor = $("cursor");
  const ripple = $("ripple");
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width * 0.62;
  const y = r.top + r.height * 0.55;
  const u = easeOut((t - tMove) / Math.max(0.12, tClick - tMove));
  cursor.style.opacity = String(clamp01(u * 1.4));
  cursor.style.left = lerp(x - 160, x, u) + "px";
  cursor.style.top = lerp(y - 70, y, u) + "px";
  if (t >= tClick && t < tClick + 0.18) {
    const k = 1 - (t - tClick) / 0.18;
    ripple.style.opacity = String(k);
    ripple.style.left = x + "px";
    ripple.style.top = y + "px";
    ripple.style.transform = `translate(-50%,-50%) scale(${1 + (1 - k) * 2.4})`;
  }
}

window.seek = function seek(t) {
  t = clamp(t, 0, DURATION);
  const wrap = $("product-wrap");
  const flash = $("flash");
  const cursor = $("cursor");
  const ripple = $("ripple");
  const punch = $("punch");
  const end = $("endcard");
  const glow = $("glow");
  const shade = $("shade");
  const scrim = $("scrim");

  glow.style.transform = `translate(${Math.sin(t * 0.35) * 40}px, ${Math.cos(t * 0.22) * 24}px)`;

  let flashA = 0;
  for (const c of CUTS) {
    if (t >= c && t < c + 0.07) flashA = Math.max(flashA, 0.42 * (1 - (t - c) / 0.07));
  }
  if (t >= 0.4 && t < 0.5) flashA = Math.max(flashA, 0.55 * (1 - (t - 0.4) / 0.1));
  flash.style.opacity = String(flashA);

  punch.style.opacity = "0";
  end.style.display = "none";
  cursor.style.opacity = "0";
  ripple.style.opacity = "0";
  shade.style.opacity = "0";
  scrim.style.opacity = "0";
  vis($("approval"), false);
  vis($("art-bar"), false);
  vis($("user-msg"), false);
  document.querySelectorAll("[data-tool]").forEach((el) => {
    el.style.display = "none";
  });
  $("nav-sched").classList.remove("active");
  $("session-home").classList.toggle("selected", t < 8.4);
  $("session-chat").classList.toggle("selected", t >= 8.4);

  let camera = CAM.hidden;
  $("copy").style.display = "block";

  if (t < 3.6) {
    showScreen("home");
    camera = mixCam(CAM.hidden, CAM.intro, (t - 1.6) / 1.6);
    setCopy({
      center: true,
      kicker: "DESKTOP AI",
      title: "miniQ",
      sub: "你说目标，它来执行",
    });
    slamCopy(t, 0.38);
    if (t > 3.3) fadeCopy(t, 3.6, 0.28);
  } else if (t < 8.4) {
    showScreen("chat");
    vis($("user-msg"), false);
    setTools(0);
    camera = mixCam(CAM.intro, CAM.type, (t - 3.6) / 1.1);
    setCopy({
      kicker: "GOAL",
      title: "你说一句<br/>目标",
      sub: "随心输入，Enter 发送",
      x: 88,
      y: 210,
    });
    slamCopy(t, 3.62);
    const p = typeText($("typed"), GOAL, t, 4.35, 14);
    $("home-composer")?.classList.toggle("focus", false);
    $("chat-composer").classList.toggle("focus", t > 4.2 && t < 8.05);
    $("send").classList.toggle("pulse", t > 7.95 && t < 8.2);
    shade.style.opacity = "0.9";
    if (t > 7.55) aimCursor("send", t, 7.55, 8.05);
  } else if (t < 14.4) {
    showScreen("chat");
    vis($("user-msg"), true);
    $("typed").innerHTML = `<span class="ph">随心输入,Enter 发送,/ 引用技能</span>`;
    setTools(t);
    camera = mixCam(CAM.type, CAM.tools, (t - 8.4) / 0.8);
    setCopy({
      kicker: "AGENT",
      title: "剩下的<br/>它来跑",
      sub: "读仓库 · 搜代码 · 写文档",
      x: 80,
      y: 180,
    });
    slamCopy(t, 8.42);
    shade.style.opacity = "1";
  } else if (t < 19.8) {
    showScreen("chat");
    vis($("user-msg"), true);
    setTools(20);
    vis($("approval"), true);
    camera = mixCam(CAM.tools, CAM.appr, (t - 14.4) / 0.7);
    setCopy({
      kicker: "CONTROL",
      title: "高风险？<br/>先问你",
      sub: "请求批准 · 替我审批 · 完全访问",
      x: 72,
      y: 150,
    });
    slamCopy(t, 14.42);
    $("btn-allow").style.transform = t > 18.9 && t < 19.2 ? "scale(0.96)" : "scale(1)";
    $("appr-badge").textContent = t > 19.1 ? "succeeded" : "waiting_approval";
    $("appr-badge").className = "badge " + (t > 19.1 ? "succeeded" : "waiting_approval");
    shade.style.opacity = "1";
    if (t > 18.55) aimCursor("btn-allow", t, 18.55, 19.02);
  } else if (t < 24.8) {
    showScreen("docs");
    vis($("art-bar"), false);
    camera = mixCam(CAM.appr, CAM.docs, (t - 19.8) / 0.75);
    setCopy({
      kicker: "ARTIFACTS",
      title: "报告<br/>直接落盘",
      sub: "docx · xlsx · md",
      x: 80,
      y: 200,
    });
    slamCopy(t, 19.82);
    shade.style.opacity = "0.95";
  } else if (t < 29.4) {
    showScreen("browser");
    const hit = t > 26.4;
    $("rpa-btn").classList.toggle("rpa-hit", hit);
    $("rpa-tag").style.opacity = hit ? "1" : "0";
    $("rpa-tag").style.left = "210px";
    $("rpa-tag").style.top = "168px";
    camera = mixCam(CAM.docs, CAM.browser, (t - 24.8) / 0.7);
    setCopy({
      kicker: "BROWSER",
      title: "浏览器<br/>也能开",
      sub: "真实页面 · 可点击 · 可填写",
      x: 80,
      y: 190,
    });
    slamCopy(t, 24.82);
    shade.style.opacity = "0.95";
    if (t > 26.0) aimCursor("rpa-btn", t, 26.0, 26.55);
  } else if (t < 33.8) {
    showScreen("skill");
    camera = mixCam(CAM.browser, CAM.skill, (t - 29.4) / 0.65);
    setCopy({
      kicker: "SKILL",
      title: "做完一次<br/>沉淀成技能",
      sub: "/ 引用技能，下次直接用",
      x: 72,
      y: 180,
    });
    slamCopy(t, 29.42);
    shade.style.opacity = "1";
  } else if (t < 38.0) {
    showScreen("schedule");
    $("nav-sched").classList.add("active");
    camera = mixCam(CAM.skill, CAM.sched, (t - 33.8) / 0.65);
    setCopy({
      kicker: "SCHEDULE",
      title: "定时任务<br/>自己跑",
      sub: "每日简报 · 每周回顾 · 项目监控",
      x: 80,
      y: 190,
    });
    slamCopy(t, 33.82);
    shade.style.opacity = "0.9";
  } else if (t < 47.0) {
    showScreen("remote");
    camera = { ...CAM.remote, op: 0.9, blur: 0, s: 0.88 };
    $("copy").style.display = "none";
    scrim.style.opacity = "0.35";
    $("remote-pause").classList.toggle("pulse", t >= 38.65 && t < 39.15);
    $("remote-continue").classList.toggle("pulse", t >= 39.35 && t < 39.9);
    $("remote-approve").classList.toggle("pulse", t >= 40.15 && t < 40.7);
    const punches = [
      [38.05, "国内外模型"],
      [38.72, "同一套工具流"],
      [39.39, "远程控制"],
      [40.06, "远程批准"],
      [40.73, "继续工作"],
    ];
    punch.style.opacity = "0";
    for (const [t0, word] of punches) {
      if (t >= t0 && t < t0 + 0.78) {
        const u = easeOut((t - t0) / 0.18);
        const out = clamp01((t0 + 0.78 - t) / 0.12);
        punch.textContent = word;
        punch.style.opacity = String(Math.min(u, out));
        punch.style.transform = `translate(-50%,-50%) scale(${1.18 - 0.18 * u})`;
        punch.style.filter = `blur(${(1 - u) * 8}px)`;
      }
    }
  } else {
    showScreen("home");
    camera = mixCam(CAM.remote, CAM.exit, (t - 47.0) / 0.7);
    $("copy").style.display = "none";
    end.style.display = "flex";
    const u = easeOut((t - 47.02) / 0.4);
    end.style.opacity = String(u);
    end.style.transform = `scale(${1.12 - 0.12 * u})`;
    $("end-sub").style.opacity = String(easeOut((t - 47.7) / 0.4));
  }

  cam(wrap, camera);
};

async function boot() {
  try {
    await document.fonts.load('600 72px "MiSans VF"');
    await document.fonts.ready;
  } catch {}
  window.seek(0);
  window.__ready = true;

  const params = new URLSearchParams(location.search);
  if (params.has("preview")) {
    const t0 = performance.now();
    const loop = (now) => {
      window.seek(((now - t0) / 1000) % DURATION);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

boot();
