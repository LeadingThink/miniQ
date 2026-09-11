"use strict";

(() => {
  const button = /** @type {HTMLButtonElement} */ (
    document.getElementById("sound")
  );
  const layer = document.getElementById("effects");
  /** @type {AudioContext | undefined} */
  let audio;
  let enabled = false;

  function tone(frequency, endFrequency, duration) {
    if (!enabled || !audio || audio.state !== "running") return;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(
      endFrequency,
      audio.currentTime + duration
    );
    gain.gain.setValueAtTime(0.06, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + duration);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (!audio) audio = new AudioContext();
      await audio.resume();
      enabled = !enabled;
      button.setAttribute("aria-pressed", String(enabled));
      button.title = enabled ? "关闭音效" : "开启音效";
      button.setAttribute("aria-label", button.title);
      tone(440, 660, 0.12);
    } catch {
      enabled = false;
      button.title = "音频设备不可用";
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", "false");
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener("stardust-action", (event) => {
    const { kind, from, to } = /** @type {CustomEvent} */ (event).detail;
    const x = from.x * 100 + 50;
    const y = from.y * 100 + 50;
    const tx = to.x * 100 + 50;
    const ty = to.y * 100 + 50;
    if (kind === "fire") {
      layer.innerHTML = `<g class="shot"><path d="M${x} ${y}L${tx} ${ty}" stroke="#ecfeaf" stroke-width="5"/><circle cx="${tx}" cy="${ty}" r="25" fill="none" stroke="#ffb898" stroke-width="4"/></g>`;
      tone(1000, 90, 0.23);
    } else if (kind === "guard") {
      layer.innerHTML = `<circle class="shield" cx="${x}" cy="${y}" r="43" fill="#88d9e330" stroke="#88d9e3" stroke-width="3"/>`;
      tone(160, 600, 0.3);
    } else if (kind === "move") {
      layer.innerHTML = `<path class="thrust" d="M${x} ${y}L${tx} ${ty}" fill="none" stroke="#88d9e3" stroke-width="3" stroke-dasharray="8 6"/>`;
      tone(100, 230, 0.2);
    } else {
      layer.innerHTML = "";
    }
  });
})();
