"use strict";
(() => {
  /** @typedef {{x: number, y: number}} Point */
  /** @typedef {Point & {hp: number, energy: number}} Player */
  /** @typedef {Point & {hp: number, max: number, name: string, boss?: boolean}} Enemy */
  const $ = (id) => document.getElementById(id);
  const controls = {
    move: /** @type {HTMLButtonElement} */ ($("move")),
    fire: /** @type {HTMLButtonElement} */ ($("fire")),
    guard: /** @type {HTMLButtonElement} */ ($("guard")),
    result: /** @type {HTMLDialogElement} */ ($("result")),
    hp: /** @type {HTMLMeterElement} */ ($("hp-meter")),
    energy: /** @type {HTMLMeterElement} */ ($("energy-meter")),
  };
  /** @param {Point} a @param {Point} b */
  const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  /** @param {Point} p */
  const coordinate = (p) => `${String.fromCharCode(65 + p.x)}${p.y + 1}`;
  /** @type {Player} */
  let player;
  /** @type {Enemy[]} */
  let enemies;
  /** @type {Point | null} */
  let selected;
  /** @type {HTMLButtonElement[]} */
  let cells = [];
  let turn = 1,
    over = false,
    focusPosition = { x: 2, y: 5 };

  // Compact original map sprites keep silhouettes readable on small cells.
  function mecha(enemy = false, boss = false) {
    const white = enemy ? (boss ? "#bf79e1" : "#dd756e") : "#e5edf1";
    return `<svg class="mecha" viewBox="0 0 80 100" aria-hidden="true"><path d="M27 72 L22 95 L34 95 L40 75 L46 95 L58 95 L53 72" fill="${white}" stroke="#111b24" stroke-width="2"/><path d="M28 78 L40 67 L52 78 L55 58 L25 58Z" fill="#667d8d"/><path d="M17 33 L5 40 L8 66 L20 69 L24 45 M63 33 L75 40 L72 66 L60 69 L56 45" fill="${white}" stroke="#111b24" stroke-width="2"/><path d="M22 34 L58 34 L55 61 L25 61Z" fill="${
      enemy ? "#693d55" : "#467791"
    }" stroke="#111b24" stroke-width="2"/><path d="M26 42 L35 42 L35 49 L26 47 M45 42 L54 42 L54 47 L45 49" fill="#f1cb64"/><path d="M35 53 L45 53 L48 62 L32 62Z" fill="#e56f69"/><path d="M29 19 L33 9 L47 9 L51 19 L49 31 L31 31Z" fill="${white}" stroke="#111b24" stroke-width="2"/><path d="M30 21 L50 21 L46 25 L34 25Z" fill="#99ffe0"/><path d="M39 20 L23 4 L36 12 L40 7 L44 12 L57 4 L41 20" fill="#f6d978"/><path d="M38 27 L42 27 L44 33 L36 33Z" fill="#de736d"/><path d="M7 52 L13 52 L14 88 L8 88Z" fill="#7893a2"/><path d="M61 46 L75 43 L76 71 L68 81 L60 70Z" fill="${white}" stroke="#111b24" stroke-width="2"/><path d="M66 49 L70 48 L70 70 L66 65Z" fill="#e56f69"/><path d="M28 80 L24 99 M52 80 L56 99" stroke="#7ed6e8" stroke-width="3" opacity=".7"/></svg>`;
  }

  function log(text) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = `T${String(turn).padStart(2, "0")}`;
    li.append(time, document.createTextNode(text));
    $("log").prepend(li);
    $("log").scrollTop = 0;
  }
  /** @param {string} kind @param {Point} [to] */
  function effect(kind, to = player) {
    document.dispatchEvent(
      new CustomEvent("stardust-action", {
        detail: { kind, from: { ...player }, to: { ...to } },
      })
    );
  }
  function start() {
    player = { x: 2, y: 5, hp: 100, energy: 100 };
    enemies = [
      { x: 1, y: 0, hp: 40, max: 40, name: "赤隼一号" },
      { x: 6, y: 0, hp: 40, max: 40, name: "赤隼二号" },
      { x: 7, y: 2, hp: 40, max: 40, name: "赤隼三号" },
      { x: 4, y: 0, hp: 80, max: 80, name: "紫电指挥机", boss: true },
    ];
    turn = 1;
    selected = null;
    over = false;
    focusPosition = { ...player };
    $("log").replaceChildren();
    controls.result.close();
    effect("reset");
    log("舰桥：四个敌方信号。咖啡可以凉，殖民卫星不能丢。");
    $("hint").textContent = "火控待命 · 等待指令";
    render();
  }
  /** @param {Point} p */
  function at(p) {
    return enemies.find((e) => e.x === p.x && e.y === p.y);
  }
  function canMove() {
    return Boolean(
      selected &&
        !at(selected) &&
        distance(player, selected) > 0 &&
        distance(player, selected) <= 2
    );
  }
  function canFire() {
    return Boolean(
      selected &&
        at(selected) &&
        distance(player, selected) <= 4 &&
        player.energy >= 30
    );
  }

  function focusCell(p) {
    focusPosition = p;
    cells.forEach((cell, index) => {
      cell.tabIndex = index === p.y * 8 + p.x ? 0 : -1;
    });
    cells[p.y * 8 + p.x].focus({ preventScroll: true });
  }
  function selectCell(p) {
    selected = p;
    const enemy = at(p);
    const range = distance(player, p);
    render();
    focusCell(p);
    if (enemy) {
      const status =
        range > 4 ? "超出射程" : player.energy < 30 ? "能源不足" : "光束已锁定";
      $(
        "hint"
      ).textContent = `${enemy.name} · 装甲 ${enemy.hp} · 距离 ${range} · ${status}`;
    } else {
      $("hint").textContent =
        range === 0
          ? "星尘号待命。"
          : `${coordinate(p)} · 距离 ${range} · ${
              range > 2 ? "超出推进范围" : "推进器就绪"
            }`;
    }
  }
  function navigate(event, p) {
    const offsets = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    focusCell({
      x: Math.max(0, Math.min(7, p.x + offset[0])),
      y: Math.max(0, Math.min(5, p.y + offset[1])),
    });
  }
  function renderBoard() {
    const focused = document.activeElement;
    const activeIndex = cells.findIndex((cell) => cell === focused);
    cells = [];
    $("board").replaceChildren();
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 8; x++) {
        const p = { x, y },
          enemy = at(p),
          friendly = player.x === x && player.y === y;
        const cell = document.createElement("button");
        cell.className = [
          "cell",
          friendly && "friendly",
          enemy && "hostile",
          enemy?.boss && "commander",
          selected && distance(p, selected) === 0 && "chosen",
          !over &&
            !enemy &&
            !friendly &&
            distance(p, player) <= 2 &&
            "reachable",
          !over &&
            enemy &&
            distance(p, player) <= 4 &&
            player.energy >= 30 &&
            "in-range",
        ]
          .filter(Boolean)
          .join(" ");
        cell.setAttribute(
          "aria-label",
          `${coordinate(p)} ${
            friendly
              ? "星尘号"
              : enemy
              ? `${enemy.name} 装甲${enemy.hp}`
              : "空域"
          }`
        );
        cell.setAttribute(
          "aria-pressed",
          String(Boolean(selected && distance(p, selected) === 0))
        );
        cell.tabIndex = distance(p, focusPosition) === 0 ? 0 : -1;
        cell.disabled = over;
        cell.innerHTML =
          `<span class="coord">${coordinate(p)}</span>` +
          (friendly || enemy
            ? mecha(!friendly, enemy?.boss) +
              `<span class="unit-health" style="transform:scaleX(${
                friendly ? player.hp / 100 : enemy.hp / enemy.max
              })"></span>`
            : "");
        cell.onclick = () => {
          if (!over) selectCell(p);
        };
        cell.onkeydown = (event) => navigate(event, p);
        cells.push(cell);
        $("board").append(cell);
      }
    if (activeIndex >= 0 && !over) focusCell(focusPosition);
  }
  function render() {
    renderBoard();
    $("hp").textContent = `${player.hp} / 100`;
    controls.hp.value = player.hp;
    $("energy").textContent = `${player.energy} / 100`;
    controls.energy.value = player.energy;
    controls.hp.textContent = String(player.hp);
    controls.energy.textContent = String(player.energy);
    controls.hp.classList.toggle("critical", player.hp <= 30);
    $("unit-status").textContent =
      player.hp === 0 ? "OFFLINE" : player.hp <= 30 ? "CRITICAL" : "ONLINE";
    $("unit-status").classList.toggle("critical", player.hp <= 30);
    $("turn").textContent = `回合 ${String(turn).padStart(2, "0")}`;
    $("kills").textContent = `0${4 - enemies.length} / 04`;
    $("position").textContent = `坐标 ${coordinate(player)}`;
    $("target").textContent = selected
      ? `LOCK ${coordinate(selected)}`
      : "未锁定";
    controls.move.disabled = over || !canMove();
    controls.fire.disabled = over || !canFire();
    controls.guard.disabled = over;
  }
  function finish(won) {
    over = true;
    $("result-title").textContent = won
      ? "星海仍然明亮。"
      : "信号中断，驾驶员已弹出。";
    $("result-text").textContent = won
      ? `任务完成！历经 ${turn} 回合，剩余装甲 ${player.hp}%。殖民卫星为你点亮了全部港灯。舰载 AI：现在可以报销那杯咖啡了。`
      : `击破 ${
          4 - enemies.length
        } 台敌机。救援艇已经出发。试试拉开距离，优先击破普通敌机，并用防御降低集火伤害。`;
    $("hint").textContent = won ? "任务完成。" : "任务结束。";
    render();
    controls.result.showModal();
  }
  function enemyTurn(guarding) {
    if (!enemies.length) {
      finish(true);
      return;
    }
    let damage = 0;
    for (const e of enemies) {
      if (distance(e, player) <= 3) damage += guarding ? 2 : e.boss ? 12 : 8;
      else {
        const candidates = [
          { x: e.x + 1, y: e.y },
          { x: e.x - 1, y: e.y },
          { x: e.x, y: e.y + 1 },
          { x: e.x, y: e.y - 1 },
        ]
          .filter(
            (p) =>
              p.x >= 0 &&
              p.x < 8 &&
              p.y >= 0 &&
              p.y < 6 &&
              !at(p) &&
              distance(p, player) > 0
          )
          .sort((a, b) => distance(a, player) - distance(b, player));
        if (candidates.length) Object.assign(e, candidates[0]);
      }
    }
    player.hp = Math.max(0, player.hp - damage);
    if (damage)
      log(
        `装甲告警：受到 ${damage} 点伤害${
          guarding ? "，护盾成功削弱来袭光束。" : "。"
        }`
      );
    else log("雷达：敌方编队正在接近。");
    if (!player.hp) {
      finish(false);
      return;
    }
    turn++;
    selected = null;
    $("hint").textContent = `敌方行动结束 · ${
      damage ? `装甲损失 ${damage}` : "无损伤"
    } · 火控待命`;
    render();
    focusCell(player);
  }
  $("move").onclick = () => {
    if (over || !canMove()) return;
    effect("move", selected);
    Object.assign(player, selected);
    log(`星尘号推进至 ${coordinate(player)}。`);
    enemyTurn(false);
  };
  $("fire").onclick = () => {
    if (over || !canFire()) return;
    effect("fire", selected);
    const enemy = at(selected);
    player.energy -= 30;
    enemy.hp -= 40;
    log(
      `光束命中 ${enemy.name}，造成 40 点伤害${
        enemy.hp <= 0 ? "，目标击破！" : "。"
      }`
    );
    enemies = enemies.filter((e) => e.hp > 0);
    enemyTurn(false);
  };
  $("guard").onclick = () => {
    if (over) return;
    effect("guard");
    const restored = Math.min(35, 100 - player.energy);
    player.energy += restored;
    log(`粒子护盾展开，能源回复 ${restored}。舰载 AI：这叫战术休息。`);
    enemyTurn(true);
  };
  $("reset").onclick = () => {
    if (over || turn === 1 || confirm("放弃当前战局，重新出击？")) start();
  };
  $("again").onclick = () => {
    start();
    focusCell(player);
  };
  start();
})();
