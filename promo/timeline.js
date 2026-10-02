const DURATION = 92;
const GOAL = "根据项目写一份多模态产品报告，并配上插画与主题音频";

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeInOut = (t) => {
  t = clamp01(t);
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
};

// 新的切点：每个重要转场
const CUTS = [6, 18, 34, 42, 48, 60, 72, 86];

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
  result: { x: -80, y: 10, s: 0.92, ry: 10, rx: 2, blur: 0, op: 1 },
  voiceInput: { x: 220, y: 20, s: 0.86, ry: -10, rx: 3, blur: 0, op: 1 },
  tools: { x: 40, y: -10, s: 0.96, ry: -4, rx: 1, blur: 0, op: 1 },
  upload: { x: 180, y: 0, s: 0.9, ry: -8, rx: 2, blur: 0, op: 1 },
  docsOut: { x: -100, y: 20, s: 0.94, ry: 12, rx: 2, blur: 0, op: 1 },
  appr: { x: -20, y: -30, s: 1.08, ry: 0, rx: 0, blur: 0, op: 1 },
  mobile: { x: 60, y: 0, s: 0.88, ry: -6, rx: 2, blur: 0, op: 1 },
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
  const starts = [10.5, 11.5, 12.6, 13.8, 15.0, 19.5, 23.5];
  steps.forEach((el, i) => {
    const t0 = starts[i] ?? (15.0 + i);
    const marker = el.querySelector(".tool-step-marker");
    const action = el.querySelector(".tool-action");
    if (t < t0) {
      el.style.display = "none";
      el.className = "tool-step";
      return;
    }
    el.style.display = "block";
    const done = t > t0 + 0.9;
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
  vis($("media-img"), false);
  vis($("media-audio"), false);
  document.querySelectorAll("[data-tool]").forEach((el) => {
    el.style.display = "none";
  });
  $("nav-sched").classList.remove("active");
  $("session-home").classList.toggle("selected", t < 18);
  $("session-chat").classList.toggle("selected", t >= 18);

  let camera = CAM.hidden;
  $("copy").style.display = "block";

  // ========== 第一幕：从结果开始 (0–6s) ==========
  if (t < 6) {
    showScreen("docs");
    vis($("art-bar"), true);
    camera = mixCam(CAM.hidden, CAM.result, t / 1.8);
    setCopy({
      kicker: "THE RESULT",
      title: "报告<br/>已经写好了",
      sub: "你只说了一句话",
      x: 80,
      y: 180,
    });
    slamCopy(t, 0.38);
    shade.style.opacity = "0.95";
    if (t > 5.6) fadeCopy(t, 6, 0.36);
  }
  // ========== 第二幕 2.1：语音输入 + 任务拆解 (6–18s) ==========
  else if (t < 18) {
    showScreen("chat");
    vis($("user-msg"), t > 9.5);
    if (t < 9.5) {
      // 语音输入阶段
      camera = mixCam(CAM.result, CAM.voiceInput, (t - 6) / 1.2);
      setCopy({
        kicker: "HOW IT STARTS",
        title: "你随口<br/>说一句",
        sub: "语音输入，实时转写",
        x: 88,
        y: 200,
      });
      slamCopy(t, 6.05);
      // 模拟语音转写
      const voiceProgress = clamp01((t - 7.2) / 2.0);
      const partialGoal = GOAL.slice(0, Math.floor(GOAL.length * voiceProgress));
      $("typed").innerHTML = partialGoal + (voiceProgress < 1 ? `<span class="caret"></span>` : "");
      $("chat-composer").classList.toggle("focus", t > 7.0 && t < 9.3);
      shade.style.opacity = "0.9";
    } else {
      // 工具调用阶段
      camera = mixCam(CAM.voiceInput, CAM.tools, (t - 9.5) / 1.8);
      setTools(t);
      setCopy({
        kicker: "AGENT",
        title: "剩下的<br/>它来跑",
        sub: "读仓库 · 搜代码 · 写文档",
        x: 80,
        y: 180,
      });
      slamCopy(t, 9.52);
      $("typed").innerHTML = `<span class="ph">随心输入,Enter 发送,/ 引用技能</span>`;
      shade.style.opacity = "1";
    }
    if (t > 17.6) fadeCopy(t, 18, 0.36);
  }
  // ========== 第二幕 2.2：多模态创作与产物 (18–34s) ==========
  else if (t < 34) {
    showScreen("chat");
    vis($("user-msg"), true);
    setTools(t);
    vis($("media-img"), t >= 20.4);
    vis($("media-audio"), t >= 24.4);
    if (t < 26) {
      // 文件与多模态创作
      camera = mixCam(CAM.tools, CAM.upload, (t - 18) / 1.4);
      setCopy({
        kicker: "MULTIMODAL CREATION",
        title: "对话生图<br/>对话配乐",
        sub: "原生多模态 · 直接落盘视听产物",
        x: 76,
        y: 170,
      });
      slamCopy(t, 18.05);
      shade.style.opacity = "1";
    } else {
      // 文档与多模态产物展示
      showScreen("docs");
      vis($("art-bar"), true);
      camera = mixCam(CAM.upload, CAM.docsOut, (t - 26) / 1.5);
      setCopy({
        kicker: "ARTIFACTS",
        title: "视听 · 文档<br/>直接落盘",
        sub: "png · wav · docx · xlsx",
        x: 80,
        y: 200,
      });
      slamCopy(t, 26.05);
      shade.style.opacity = "0.95";
    }
    if (t > 33.6) fadeCopy(t, 34, 0.36);
  }
  // ========== 第三幕 3.1：审批与权限 (34–42s) ==========
  else if (t < 42) {
    showScreen("chat");
    vis($("user-msg"), true);
    setTools(20);
    vis($("approval"), true);
    camera = mixCam(CAM.docsOut, CAM.appr, (t - 34) / 1.2);
    setCopy({
      kicker: "YOU STAY IN CONTROL",
      title: "高风险？<br/>先问你",
      sub: "请求批准 · 替我审批 · 完全访问",
      x: 72,
      y: 150,
    });
    slamCopy(t, 34.05);
    $("btn-allow").style.transform = t > 40.5 && t < 40.8 ? "scale(0.96)" : "scale(1)";
    $("appr-badge").textContent = t > 40.7 ? "succeeded" : "waiting_approval";
    $("appr-badge").className = "badge " + (t > 40.7 ? "succeeded" : "waiting_approval");
    shade.style.opacity = "1";
    if (t > 40.0) aimCursor("btn-allow", t, 40.0, 40.6);
    if (t > 41.6) fadeCopy(t, 42, 0.36);
  }
  // ========== 第三幕 3.2：移动端接续 (42–48s) ==========
  else if (t < 48) {
    showScreen("remote");
    camera = mixCam(CAM.appr, CAM.mobile, (t - 42) / 1.2);
    setCopy({
      kicker: "ANYWHERE",
      title: "电脑手机<br/>接着干",
      sub: "同一会话，远程批准",
      x: 80,
      y: 190,
    });
    slamCopy(t, 42.05);
    $("remote-approve").classList.toggle("pulse", t >= 44.5 && t < 45.2);
    scrim.style.opacity = "0.25";
    shade.style.opacity = "0.85";
    if (t > 47.6) fadeCopy(t, 48, 0.36);
  }
  // ========== 第四幕 4.1：技能复用 (48–60s) ==========
  else if (t < 60) {
    showScreen("skill");
    camera = mixCam(CAM.mobile, CAM.skill, (t - 48) / 1.4);
    setCopy({
      kicker: "REUSABLE",
      title: "做完一次<br/>沉淀成技能",
      sub: "/ 引用技能，下次直接用",
      x: 72,
      y: 180,
    });
    slamCopy(t, 48.05);
    shade.style.opacity = "1";
    if (t > 59.6) fadeCopy(t, 60, 0.36);
  }
  // ========== 第四幕 4.2：定时任务 (60–72s) ==========
  else if (t < 72) {
    showScreen("schedule");
    $("nav-sched").classList.add("active");
    camera = mixCam(CAM.skill, CAM.sched, (t - 60) / 1.4);
    setCopy({
      kicker: "SCHEDULED",
      title: "定时任务<br/>自己跑",
      sub: "每日简报 · 每周回顾 · 项目监控",
      x: 80,
      y: 190,
    });
    slamCopy(t, 60.05);
    shade.style.opacity = "0.9";
    if (t > 71.6) fadeCopy(t, 72, 0.36);
  }
  // ========== 第四幕 4.3：模型自由度 (72–86s) ==========
  else if (t < 86) {
    showScreen("remote");
    camera = { ...CAM.remote, op: 0.9, blur: 0, s: 0.88 };
    $("copy").style.display = "none";
    scrim.style.opacity = "0.35";
    $("remote-pause").classList.toggle("pulse", t >= 73.2 && t < 73.8);
    $("remote-continue").classList.toggle("pulse", t >= 74.4 && t < 75.0);
    $("remote-approve").classList.toggle("pulse", t >= 75.6 && t < 76.2);
    const punches = [
      [72.2, "国内外模型"],
      [73.3, "同一套工具流"],
      [74.4, "Claude · GPT"],
      [75.5, "Gemini · Qwen"],
      [76.6, "DeepSeek · 豆包"],
    ];
    punch.style.opacity = "0";
    for (const [t0, word] of punches) {
      if (t >= t0 && t < t0 + 0.9) {
        const u = easeOut((t - t0) / 0.2);
        const out = clamp01((t0 + 0.9 - t) / 0.15);
        punch.textContent = word;
        punch.style.opacity = String(Math.min(u, out));
        punch.style.transform = `translate(-50%,-50%) scale(${1.18 - 0.18 * u})`;
        punch.style.filter = `blur(${(1 - u) * 8}px)`;
      }
    }
  }
  // ========== 第五幕：品牌收尾 (86–92s) ==========
  else {
    showScreen("home");
    camera = mixCam(CAM.remote, CAM.exit, (t - 86) / 1.2);
    $("copy").style.display = "none";
    end.style.display = "flex";
    const u = easeOut((t - 86.05) / 0.5);
    end.style.opacity = String(u);
    end.style.transform = `scale(${1.12 - 0.12 * u})`;
    $("end-sub").style.opacity = String(easeOut((t - 87.0) / 0.5));
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
