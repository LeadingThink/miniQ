#!/usr/bin/env python3
"""92s / 120 BPM electronic bed + hard-cut SFX for the miniQ promo (four-act narrative)."""
from __future__ import annotations

import math
import os
import struct
import wave

import numpy as np

SR = 44100
DURATION = 92.0
BPM = 120.0
BEAT = 60.0 / BPM
N = int(SR * DURATION)
OUT = os.path.join(os.path.dirname(__file__), "out", "audio.wav")


def env_exp(n: int, attack: float, decay: float) -> np.ndarray:
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    d = np.exp(-t / max(decay, 1e-4))
    return a * d


def place(buf: np.ndarray, t0: float, sig: np.ndarray, gain: float = 1.0) -> None:
    i = int(t0 * SR)
    if i >= len(buf) or i < 0:
        return
    sl = sig[: max(0, len(buf) - i)] * gain
    buf[i : i + len(sl)] += sl


def noise(n: int) -> np.ndarray:
    return (np.random.default_rng(7).standard_normal(n)).astype(np.float64)


def lowpass(x: np.ndarray, cutoff: float) -> np.ndarray:
    if len(x) == 0:
        return x
    a = math.exp(-2 * math.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def lowpass_sweep(x: np.ndarray, cutoffs: np.ndarray) -> np.ndarray:
    """One-pole low-pass with a per-sample cutoff for whoosh sweeps."""
    if len(x) == 0:
        return x
    y = np.empty_like(x)
    acc = 0.0
    for i, (v, cutoff) in enumerate(zip(x, cutoffs)):
        a = math.exp(-2 * math.pi * float(cutoff) / SR)
        acc = (1 - a) * v + a * acc
        y[i] = acc
    return y


def highpass(x: np.ndarray, cutoff: float) -> np.ndarray:
    return x - lowpass(x, cutoff)


def sine(n: int, freq: float, phase: float = 0.0) -> np.ndarray:
    t = np.arange(n) / SR
    return np.sin(2 * math.pi * freq * t + phase)


def kick(t0: float, buf: np.ndarray, gain: float = 1.0) -> None:
    n = int(0.28 * SR)
    t = np.arange(n) / SR
    freq = 148 * np.exp(-t * 18) + 38
    body = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 10)
    click = highpass(noise(n), 2500) * np.exp(-t * 80) * 0.12
    place(buf, t0, body + click, gain)


def snare(t0: float, buf: np.ndarray, gain: float = 1.0) -> None:
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    body = sine(n, 196) * np.exp(-t * 18) * 0.35
    nse = highpass(noise(n), 1800) * np.exp(-t * 14)
    place(buf, t0, body + nse * 0.7, gain)


def hat(t0: float, buf: np.ndarray, gain: float = 0.35, open_: bool = False) -> None:
    n = int((0.12 if not open_ else 0.28) * SR)
    t = np.arange(n) / SR
    decay = 28 if not open_ else 9
    nse = highpass(noise(n), 6000) * np.exp(-t * decay)
    place(buf, t0, nse, gain)


def tom(t0: float, buf: np.ndarray, freq: float, gain: float = 0.6) -> None:
    n = int(0.18 * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * np.pi * (freq * np.exp(-t * 6)) * t) * np.exp(-t * 12)
    place(buf, t0, sig, gain)


def whoosh(t0: float, buf: np.ndarray, dur: float = 0.38, gain: float = 0.55) -> None:
    n = int(dur * SR)
    t = np.arange(n) / SR
    nse = noise(n)
    sweep = lowpass_sweep(nse, 400 + 4200 * (t / dur) ** 1.4)
    env = np.sin(math.pi * np.clip(t / dur, 0, 1)) ** 1.2
    place(buf, t0, sweep * env, gain)


def slam(t0: float, buf: np.ndarray) -> None:
    n = int(0.55 * SR)
    t = np.arange(n) / SR
    sub = np.sin(2 * np.pi * 48 * t) * np.exp(-t * 6)
    nse = lowpass(noise(n), 900) * np.exp(-t * 10)
    place(buf, t0, sub * 1.1 + nse * 0.45, 0.9)
    whoosh(t0 - 0.08, buf, 0.22, 0.35)


def click(t0: float, buf: np.ndarray) -> None:
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    sig = highpass(noise(n), 3000) * np.exp(-t * 90)
    tick = sine(n, 2400) * np.exp(-t * 70) * 0.4
    place(buf, t0, sig + tick, 0.55)


def key(t0: float, buf: np.ndarray, seed: int) -> None:
    rng = np.random.default_rng(seed)
    n = int(0.045 * SR)
    t = np.arange(n) / SR
    f = float(rng.integers(1400, 2600))
    sig = sine(n, f) * np.exp(-t * 70) * 0.25 + highpass(rng.standard_normal(n), 4000) * np.exp(-t * 90) * 0.15
    place(buf, t0, sig, 0.45)


def ding(t0: float, buf: np.ndarray) -> None:
    n = int(0.7 * SR)
    t = np.arange(n) / SR
    sig = (
        sine(n, 880) * np.exp(-t * 4)
        + sine(n, 1320) * np.exp(-t * 5) * 0.5
        + sine(n, 1760) * np.exp(-t * 7) * 0.25
    )
    place(buf, t0, sig, 0.35)


def stab(t0: float, buf: np.ndarray, freq: float) -> None:
    n = int(0.32 * SR)
    t = np.arange(n) / SR
    sig = (sine(n, freq) + 0.4 * sine(n, freq * 2) + 0.15 * sine(n, freq * 3)) * np.exp(-t * 9)
    place(buf, t0, sig, 0.42)
    slam_n = int(0.12 * SR)
    ts = np.arange(slam_n) / SR
    place(buf, t0, lowpass(noise(slam_n), 700) * np.exp(-ts * 30), 0.25)


def bass_note(t0: float, buf: np.ndarray, freq: float, dur: float, gain: float = 0.28) -> None:
    n = int(dur * SR)
    t = np.arange(n) / SR
    env = np.minimum(t / 0.02, 1.0) * np.exp(-t * 1.6)
    env = np.minimum(env, np.clip((dur - t) / 0.04, 0, 1))
    sig = np.tanh(sine(n, freq) * 1.6) * 0.7 + sine(n, freq * 0.5) * 0.35
    place(buf, t0, sig * env, gain)


def pad(t0: float, buf: np.ndarray, freqs: list[float], dur: float, gain: float = 0.08) -> None:
    n = int(dur * SR)
    t = np.arange(n) / SR
    env = np.minimum(t / 0.4, 1.0) * np.clip((dur - t) / 0.5, 0, 1)
    sig = np.zeros(n)
    for i, f in enumerate(freqs):
        sig += sine(n, f, i * 0.4) * (0.5 if i else 1.0)
        sig += sine(n, f * 1.005, i) * 0.25
    place(buf, t0, sig * env, gain)


def arp(t0: float, buf: np.ndarray, freq: float, gain: float = 0.09) -> None:
    n = int(0.14 * SR)
    t = np.arange(n) / SR
    env = np.exp(-t * 16)
    sig = sine(n, freq) * env + sine(n, freq * 2) * env * 0.25
    place(buf, t0, sig, gain)


def reverse_cymbal(t0: float, buf: np.ndarray, dur: float = 1.4) -> None:
    n = int(dur * SR)
    t = np.arange(n) / SR
    nse = highpass(noise(n), 2500) * (t / dur) ** 2
    place(buf, t0, nse, 0.28)


def main() -> None:
    rng = np.random.default_rng(11)
    mix = np.zeros(N, dtype=np.float64)

    # ========== 第一幕：从结果开始 (0–6s) ==========
    # 开场：低沉 pad + reverse cymbal riser
    pad(0.0, mix, [110, 164.81, 220], 6.5, 0.06)
    reverse_cymbal(4.5, mix, 1.6)
    slam(0.42, mix)
    whoosh(0.15, mix, 0.5, 0.4)
    
    # ========== 第二幕 2.1：语音输入 + 任务拆解 (6–18s) ==========
    # 切入主题：和弦进行开始，鼓点进入
    chords = [
        (6.0, [220.00, 261.63, 329.63], 110.00),   # Am
        (10.0, [174.61, 220.00, 261.63], 87.31),   # F
        (14.0, [130.81, 164.81, 196.00], 65.41),   # C
    ]
    
    # ========== 第二幕 2.2：真实资料到交付文件 (18–34s) ==========
    chords.extend([
        (18.0, [196.00, 246.94, 293.66], 98.00),   # G
        (22.0, [220.00, 261.63, 329.63], 110.00),  # Am
        (26.0, [174.61, 220.00, 261.63], 87.31),   # F
        (30.0, [130.81, 164.81, 196.00], 65.41),   # C
    ])
    
    # ========== 第三幕 3.1：审批与权限 (34–42s) ==========
    chords.extend([
        (34.0, [196.00, 246.94, 293.66], 98.00),   # G
        (38.0, [220.00, 261.63, 329.63], 110.00),  # Am
    ])
    
    # ========== 第三幕 3.2：移动端接续 (42–48s) ==========
    chords.extend([
        (42.0, [174.61, 220.00, 261.63], 87.31),   # F
        (46.0, [130.81, 164.81, 196.00], 65.41),   # C
    ])
    
    # ========== 第四幕 4.1：技能复用 (48–60s) ==========
    chords.extend([
        (48.0, [196.00, 246.94, 293.66], 98.00),   # G
        (52.0, [220.00, 261.63, 329.63], 110.00),  # Am
        (56.0, [174.61, 220.00, 261.63], 87.31),   # F
    ])
    
    # ========== 第四幕 4.2：定时任务 (60–72s) ==========
    chords.extend([
        (60.0, [130.81, 164.81, 196.00], 65.41),   # C
        (64.0, [196.00, 246.94, 293.66], 98.00),   # G
        (68.0, [220.00, 261.63, 329.63], 110.00),  # Am
    ])
    
    # ========== 第四幕 4.3：模型自由度 (72–86s) ==========
    chords.extend([
        (72.0, [174.61, 220.00, 329.63], 87.31),   # F
        (76.0, [130.81, 164.81, 196.00], 65.41),   # C
        (80.0, [196.00, 246.94, 293.66], 98.00),   # G
        (84.0, [220.00, 261.63, 329.63], 110.00),  # Am
    ])
    
    # Render all chords with bass
    for t0, freqs, root in chords:
        pad(t0, mix, freqs, 4.2, 0.07)
        # bass on beats
        for k in range(8):
            bass_note(t0 + k * BEAT, mix, root if k % 4 != 3 else root * 1.5, 0.42, 0.22)

    # Drums from 6s (when narrative starts) through 86s
    drum_start = 6.0
    drum_end = 86.0
    beat_i = 0
    t = drum_start
    while t < drum_end:
        kick(t, mix, 0.85 if beat_i % 4 == 0 else 0.72)
        if beat_i % 2 == 1:
            snare(t, mix, 0.48)
        hat(t, mix, 0.22)
        hat(t + 0.25, mix, 0.14)
        if beat_i % 8 == 7:
            hat(t + 0.25, mix, 0.2, open_=True)
        # arp 16ths throughout
        if 10.0 <= t < 86.0:
            scale = [1.0, 1.2, 1.5, 1.8]
            arp(t + 0.125, mix, 220 * scale[beat_i % 4], 0.07)
        beat_i += 1
        t += BEAT

    # Scene cut whooshes (at each act transition)
    whoosh(5.88, mix, 0.35, 0.6)     # 0→6: 第一幕结束
    whoosh(17.88, mix, 0.32, 0.58)   # 6→18: 第二幕 2.1→2.2
    whoosh(33.88, mix, 0.32, 0.58)   # 18→34: 第二幕→第三幕
    whoosh(41.88, mix, 0.30, 0.55)   # 34→42: 第三幕 3.1→3.2
    whoosh(47.88, mix, 0.30, 0.55)   # 42→48: 第三幕→第四幕
    whoosh(59.88, mix, 0.30, 0.52)   # 48→60: 第四幕 4.1→4.2
    whoosh(71.88, mix, 0.30, 0.52)   # 60→72: 第四幕 4.2→4.3
    whoosh(85.88, mix, 0.32, 0.58)   # 72→86: 第四幕→第五幕

    # Typing (7.2–9.2s during voice input transcription)
    type_t = 7.3
    ki = 0
    while type_t < 9.2:
        key(type_t, mix, 200 + ki)
        type_t += float(rng.uniform(0.055, 0.095))
        ki += 1
    
    # Send click at 9.5s
    click(9.5, mix)
    tom(9.52, mix, 180, 0.4)

    # Tool step ticks (10.5–24.0s during tool execution)
    for tt in (10.5, 11.5, 12.6, 13.8, 15.0, 19.5, 23.5):
        click(tt, mix)
        tom(tt, mix, 210, 0.28)
    # Media arrival chime / chime stabs
    ding(20.4, mix)
    ding(24.4, mix)

    # Approve click at 40.6s
    click(40.6, mix)
    ding(40.7, mix)

    # Mobile remote approve at 44.8s
    click(44.8, mix)
    ding(44.9, mix)

    # Skill save at 52s
    click(52.0, mix)
    ding(52.15, mix)

    # Schedule task at 64s
    click(64.0, mix)
    ding(64.15, mix)

    # Model punches (72–77s)
    for i, (tt, f) in enumerate([
        (72.2, 220), (73.3, 261.63), (74.4, 329.63), 
        (75.5, 392.00), (76.6, 440.00)
    ]):
        stab(tt, mix, f)

    # ========== 第五幕：品牌收尾 (86–92s) ==========
    reverse_cymbal(84.5, mix, 1.6)
    slam(86.0, mix)
    ding(86.2, mix)
    pad(86.0, mix, [220, 329.63, 440], 6.5, 0.10)
    
    # Final fadeout
    mix *= np.clip((DURATION - np.arange(N) / SR) / 1.6, 0, 1)

    # Gentle sidechain-ish ducking on kicks: already decaying kicks.
    # Highpass rumble + limiter
    mix = np.tanh(mix * 1.15)
    peak = np.max(np.abs(mix)) or 1.0
    mix = mix / peak * 0.92

    stereo = np.column_stack((mix * 0.98, mix * 1.02))
    pcm = np.clip(stereo * 32767.0, -32767, 32767).astype(np.int16)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with wave.open(OUT, "w") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm.tobytes())
    print(f"audio written  {OUT}")


if __name__ == "__main__":
    main()
