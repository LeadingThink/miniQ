#!/usr/bin/env python3
"""An original 68-second, restrained spring motif, using the existing synth helpers."""
from pathlib import Path
import importlib.util
import wave
import numpy as np

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("promo_audio", ROOT.parent / "audio.py")
synth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(synth)
SR = synth.SR
DURATION = 68
mix = np.zeros(SR * DURATION, dtype=np.float64)


def felt_note(at, freq, gain=0.14, duration=2.8):
    n = int(duration * SR)
    t = np.arange(n) / SR
    attack = np.minimum(t / 0.009, 1)
    tone = sum(
        synth.sine(n, freq * ratio) * strength * np.exp(-t * decay)
        for ratio, strength, decay in [(1, 1, 1.6), (2, .24, 2.8), (3, .075, 4.3)]
    )
    sig = tone * attack * np.clip((duration - t) / .15, 0, 1)
    synth.place(mix, at, sig, gain)
    synth.place(mix, at + .19, sig, gain * .13)
    synth.place(mix, at + .37, sig, gain * .065)


# Spacious opening; the motif gains movement when the scattered inputs become a plan.
chords = [
    ([196, 246.94, 293.66, 369.99], 98),
    ([164.81, 196, 246.94, 293.66], 82.41),
    ([130.81, 164.81, 196, 246.94], 65.41),
    ([146.83, 185, 220, 293.66], 73.42),
]
for bar in range(17):
    at = bar * 4
    freqs, root = chords[bar % 4]
    synth.pad(at, mix, freqs, 4.65, .032 if at < 14 else .044)
    felt_note(at + .06, root * 2, .09, 3.6)
    for beat, index in enumerate([0, 2, 1, 3, 2, 1]):
        if at < 7 and beat % 2:
            continue
        felt_note(at + .38 + beat * .55, freqs[index] * 2, .095 if at < 14 else .125)
    if 14 <= at < 60:
        for beat in range(4):
            synth.kick(at + beat, mix, .075)
            synth.hat(at + beat + .5, mix, .013)

# A small melodic lift for the campaign reveal, and a resolved final chord.
for at, note in [(31.2, 587.33), (32.4, 493.88), (34, 392), (35.2, 440), (36.4, 493.88), (38, 392)]:
    felt_note(at, note, .14, 3)
for note in [196, 293.66, 392, 493.88]:
    felt_note(62.3, note, .11, 5.5)
t = np.arange(len(mix)) / SR
mix *= np.minimum(t / 1.6, 1) * np.clip((DURATION - t) / 4, 0, 1)
left = mix
right = mix * .95 + np.concatenate((np.zeros(397), mix[:-397])) * .05
stereo = np.column_stack((left, right))
stereo *= .78 / max(np.max(np.abs(stereo)), .01)
pcm = np.clip(stereo * 32767, -32767, 32767).astype(np.int16)
with wave.open(str(ROOT / "assets" / "spring-music.wav"), "w") as output:
    output.setnchannels(2)
    output.setsampwidth(2)
    output.setframerate(SR)
    output.writeframes(pcm.tobytes())
print("Original spring music: assets/spring-music.wav")
