"""Soundtrack for the Delulu Talks reel: underwater dream pop at 96 BPM, synthesized with numpy
and scipy, no samples. Every hit comes from score.json, the beat map reel.js animates to.

python3 soundtrack.py [OUT.wav]   -> reel.wav (48 kHz stereo, 15 s) and cues.json
Optional: pass --spectrogram to also write spectrogram.png (needs matplotlib).

Seeded, so it writes the same file every time."""

import json
import sys
import wave
from pathlib import Path

import numpy as np
from scipy import signal

HERE = Path(__file__).resolve().parent
SCORE = json.loads((HERE / 'score.json').read_text())
SR = 48000
BPM = SCORE['bpm']
BEAT = 60 / BPM
DUR = SCORE['bars'] * 4 * BEAT  # 15 s
N = int(round(DUR * SR))
CUE = {k: v * BEAT for k, v in SCORE['cues'].items()}
rng = np.random.default_rng(7)

# ------------------------------------------------------------------ helpers


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def sos(kind, f, order=2):
    return signal.butter(order, f, btype=kind, fs=SR, output='sos')


def filt(x, kind, f, order=2):
    return signal.sosfilt(sos(kind, f, order), x)


def env(n, a=0.005, r=0.05, hold=None):
    """Attack, hold, then a linear release over r seconds, n samples long."""
    t = np.arange(n) / SR
    e = np.clip(t / max(a, 1e-4), 0, 1)
    h = (n / SR - r) if hold is None else hold
    e *= np.clip(1 - (t - h) / r, 0, 1)
    return e


def saw(freq, dur, harmonics=24, detune=0.0, phase=0.0):
    """Band-limited sawtooth by additive synthesis."""
    t = tt(dur)
    f = freq * 2 ** (detune / 1200)
    out = np.zeros_like(t)
    for k in range(1, harmonics + 1):
        if f * k > 16000:
            break
        out += np.sin(2 * np.pi * f * k * t + phase * k) / k
    return out * 0.6


def bell(freq, dur, decay=1.0, bright=1.0):
    """Glass bell: inharmonic partials with faster decay for the higher ones."""
    t = tt(dur)
    out = np.zeros_like(t)
    for ratio, amp, d in ((1, 1, 1), (2.0, 0.45 * bright, 0.6), (3.01, 0.25 * bright, 0.4), (4.17, 0.18 * bright, 0.3), (5.43, 0.1 * bright, 0.2)):
        out += amp * np.sin(2 * np.pi * freq * ratio * t) * np.exp(-t / (decay * d))
    return out * np.clip(t / 0.002, 0, 1) * 0.5


def bloop(freq, dur=0.22, rise=1.7):
    """A water drop: a sine that sweeps up fast and dies away."""
    t = tt(dur)
    f = freq * (1 + (rise - 1) * (1 - np.exp(-t / 0.03)))
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / 0.06) * np.clip(t / 0.003, 0, 1)


def noise(dur):
    return rng.standard_normal(int(dur * SR))


def sweep_noise(dur, f0, f1, q=2.0, bands=24):
    """Noise through a band-pass that glides from f0 to f1 (as a crossfade of fixed bands)."""
    n = int(dur * SR)
    src = noise(dur)
    out = np.zeros(n)
    centers = np.geomspace(f0, f1, bands)
    pos = np.linspace(0, bands - 1, n)
    for i, c in enumerate(centers):
        w = np.clip(1 - np.abs(pos - i), 0, 1)
        lo, hi = c / (1 + 1 / q), min(c * (1 + 1 / q), SR / 2 - 100)
        out += w * signal.sosfilt(sos('bandpass', [lo, hi]), src)
    return out


class Bus:
    """A stereo bus with a reverb send."""

    def __init__(self):
        self.dry = np.zeros((2, N))
        self.wet = np.zeros((2, N))

    def add(self, x, t0, gain=1.0, pan=0.0, send=0.2):
        i = int(round(t0 * SR))
        if i >= N:
            return
        if i < 0:
            x, i = x[-i:], 0
        x = x[: N - i]
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        for ch, g in ((0, l), (1, r)):
            self.dry[ch, i : i + len(x)] += x * gain * g * (1 - send * 0.5)
            self.wet[ch, i : i + len(x)] += x * gain * g * send


def reverb_ir(seconds=2.6, seed=3):
    r = np.random.default_rng(seed)
    t = tt(seconds)
    ir = []
    for ch in range(2):
        x = r.standard_normal(len(t)) * np.exp(-t / (seconds / 6.5))
        x = filt(x, 'lowpass', 5200)
        x[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
        ir.append(x / np.sqrt(np.sum(x**2)))
    return ir


# ------------------------------------------------------------------- score

bus = Bus()
cues = []  # (seconds, what) for cues.json


def cue(t, what):
    cues.append({'t': round(t, 4), 'frame': int(round(t * SCORE['fps'])), 'what': what})


chords = SCORE['chords']


def chord_at(beat):
    c = chords[0]
    for ch in chords:
        if ch['beat'] <= beat:
            c = ch
    return c


# Pad: three detuned saws per note, low-passed, swelling into each chord.
for i, ch in enumerate(chords):
    t0 = ch['beat'] * BEAT
    t1 = chords[i + 1]['beat'] * BEAT if i + 1 < len(chords) else DUR
    dur = t1 - t0 + 0.9
    cutoff = 900 if ch['beat'] < 4 else 1700
    if ch['beat'] >= 20:
        cutoff = 2200
    for n, note in enumerate(ch['notes'][1:]):
        for side, det in ((-1, -9), (1, 9)):
            x = saw(hz(note), dur, 16, det, phase=n * 1.3 + side) + 0.6 * saw(hz(note), dur, 16, -det / 2)
            x = filt(x, 'lowpass', cutoff)
            a = 0.7 if ch['beat'] == 0 else 0.12
            x *= env(len(x), a=a, r=0.9 if ch['beat'] < 20 else 2.2)
            bus.add(x, t0 - (0 if ch['beat'] == 0 else 0.03), gain=0.05 if ch['beat'] == 0 else 0.028, pan=side * 0.55, send=0.45)

# Sidechain the pad so it breathes with the kick (applied later to the pad's share of the mix
# would need a separate bus; a gentle global pump on the kick beats does the same job here).
kick_beats = [b for b in range(4, 20) if b % 2 == 0] + [20]

# Kick
for b in kick_beats:
    t = tt(0.5)
    f = 48 + 95 * np.exp(-t / 0.035)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.26)
    x += 0.3 * filt(noise(0.5), 'highpass', 2500) * np.exp(-t / 0.004)
    bus.add(np.tanh(x * 1.6), b * BEAT, gain=0.62 if b != 20 else 0.75, send=0.05)

# Soft clap on 2 and 4
for b in range(5, 20, 2):
    t = tt(0.4)
    bursts = sum(np.exp(-np.clip(t - d, 0, None) / 0.012) * (t >= d) for d in (0, 0.011, 0.022))
    x = filt(noise(0.4), 'bandpass', [900, 5200]) * (bursts * 0.4 + np.exp(-t / 0.13)) * 0.5
    x += 0.4 * np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05)
    bus.add(x, b * BEAT, gain=0.2, pan=0.05, send=0.4)

# Shaker on sixteenths while the key is held and after
for k in range(4 * 4, 20 * 4):
    b = k / 4
    vel = (0.55, 0.22, 0.85, 0.3)[k % 4] * (0.8 + 0.4 * rng.random())
    t = tt(0.09)
    x = filt(noise(0.09), 'highpass', 7000) * np.exp(-t / (0.018 if k % 4 != 2 else 0.035))
    bus.add(x, b * BEAT, gain=0.09 * vel, pan=0.35 * np.sin(k), send=0.1)

# Sub bass: root on 1, a push on the and of 2, root on 3
for b in range(4, 20):
    root = chord_at(b)['notes'][0]
    while root > 47:
        root -= 12
    pos = b % 4
    if pos in (0, 2):
        dur = 0.9 * BEAT if pos == 0 else 1.4 * BEAT
        offs = [(0, dur)] if pos == 2 else [(0, dur), (1.5 * BEAT, 0.45 * BEAT)]
        for o, d in offs:
            t = tt(d)
            x = np.sin(2 * np.pi * hz(root) * t) + 0.25 * np.sin(4 * np.pi * hz(root) * t)
            x = np.tanh(1.4 * x) * env(len(t), a=0.008, r=0.08)
            bus.add(x, b * BEAT + o, gain=0.3, send=0.0)
# The last chord's bass rings out
t = tt(2.4)
x = (np.sin(2 * np.pi * hz(38) * t) + 0.25 * np.sin(4 * np.pi * hz(38) * t)) * np.exp(-t / 1.0) * env(len(t), a=0.01, r=0.4)
bus.add(np.tanh(1.3 * x), CUE['endCard'], gain=0.32, send=0.05)

# Bubble arpeggio: bar 1 and bar 5, eighth notes, ping-ponged, with a dotted-eighth echo
def arp(beats, beat0, notes, gain):
    for k in range(beats * 2):
        b = beat0 + k / 2
        note = notes[k % len(notes)] + 12
        for echo in range(3):
            pan = (-0.6 if (k + echo) % 2 else 0.6)
            bus.add(bloop(hz(note), 0.25, 1.35), b * BEAT + echo * 0.75 * BEAT, gain=gain * 0.45**echo, pan=pan, send=0.5)


arp(4, 0, [69, 73, 76, 78, 76, 73, 81, 76], 0.13)
arp(4, 16, [66, 71, 74, 78, 74, 71, 79, 76], 0.05)

# Underwater room tone: brown noise, low and slow
br = np.cumsum(rng.standard_normal(N))
br = filt(br - np.convolve(br, np.ones(4801) / 4801, 'same'), 'lowpass', 220)
br = br / np.max(np.abs(br))
bus.dry += 0.03 * np.stack([br, np.roll(br, 2400)])

# --- the story -------------------------------------------------------------

# Bar 1: the keys rise with a soft swell; a riser leads into the key press.
cue(CUE['keysRise'], 'keys rise')
x = sweep_noise(0.7, 300, 1500) * np.hanning(int(0.7 * SR))
bus.add(x, CUE['keysRise'] - 0.1, gain=0.05, send=0.5)
rl = CUE['keyDown'] - 1.0
x = sweep_noise(1.0, 400, 4500) * np.linspace(0, 1, int(1.0 * SR)) ** 2
bus.add(x, rl, gain=0.09, send=0.3)


def clack(t0, gain, bright):
    t = tt(0.12)
    x = filt(noise(0.12), 'bandpass', [1800 * bright, 6000]) * np.exp(-t / 0.008)
    x += 0.9 * np.sin(2 * np.pi * 150 * bright * t) * np.exp(-t / 0.03)
    bus.add(x, t0, gain=gain, send=0.15)


cue(CUE['keyDown'], 'key down: recording')
clack(CUE['keyDown'], 0.32, 1.0)

# The voice: one hummed syllable per sixteenth, its vowel shaped by formant filters.
FORMANTS = {'a': (800, 1150, 2900), 'e': (530, 1840, 2480), 'i': (300, 2250, 3000), 'o': (470, 850, 2600), 'u': (330, 760, 2450)}
CONSONANT = {'so': 's', 'the': 'th', 'conflict': 'k', 'is': 'z', 'sorry,': 's', 'tuesday': 't', 'merch': 'm', 'monday,': 'm', 'no': 'n'}
sp = SCORE['speech']
n = 0
for w in sp['words']:
    for si, s in enumerate(w['syllables']):
        t0 = (sp['start'] + n * sp['step']) * BEAT
        if si == 0:
            cue(t0, f'say "{w["word"].rstrip(",")}"')
        d = sp['step'] * BEAT * (0.95 if n < 14 else 1.8)
        f0 = hz(s['pitch'])
        t = tt(d)
        vib = 1 + 0.006 * np.sin(2 * np.pi * 5.5 * t)
        glide = 1 + 0.03 * np.exp(-t / 0.03)  # a little scoop into each note
        ph = 2 * np.pi * np.cumsum(f0 * vib / glide) / SR
        src = sum(np.sin(k * ph) / k for k in range(1, 40) if f0 * k < 9000)
        f1, f2, f3 = FORMANTS[s['vowel']]
        v = 1.0 * filt(src, 'bandpass', [f1 * 0.8, f1 * 1.25]) + 0.6 * filt(src, 'bandpass', [f2 * 0.88, f2 * 1.12]) + 0.25 * filt(src, 'bandpass', [f3 * 0.9, f3 * 1.1])
        v *= env(len(t), a=0.018, r=0.05)
        bus.add(v, t0, gain=0.5, pan=0.0, send=0.35)
        c = CONSONANT.get(w['word']) if si == 0 else ('t' if w['word'] == 'conflict' else None)
        if c in ('s', 'z', 't', 'k', 'th'):
            cn = filt(noise(0.05), 'highpass', 4500 if c in ('s', 'z') else 2500) * np.exp(-tt(0.05) / (0.02 if c in ('s', 'z') else 0.006))
            bus.add(cn, t0 - (0.02 if c in ('s', 'z') else 0.0), gain=0.06, send=0.2)
        n += 1

cue(CUE['keyUp'], 'key up: cleanup thinks')
clack(CUE['keyUp'], 0.2, 1.5)

# Cleanup: the filler pops, the take-back is struck and lifts away as bubbles.
cue(CUE['popFiller'], 'pop "um"')
bus.add(bloop(hz(86), 0.2, 2.2), CUE['popFiller'] - 0.01, gain=0.3, send=0.3)
for k in range(5):
    bus.add(bloop(hz(84 + 3 * k), 0.15, 1.8), CUE['popFiller'] + 0.06 + k * 0.07 + 0.03 * rng.random(), gain=0.06, pan=rng.uniform(-0.5, 0.5), send=0.5)

cue(CUE['liftTakeBack'], 'strike "monday, no sorry"')
x = sweep_noise(0.2, 1500, 7000) * np.hanning(int(0.2 * SR))
bus.add(x, CUE['liftTakeBack'], gain=0.18, pan=0.2, send=0.2)
for k in range(10):
    tb = CUE['liftTakeBack'] + 0.2 + rng.uniform(0, 0.8)
    bus.add(bloop(hz(rng.choice([78, 81, 83, 85, 88, 90])), 0.18, 1.9), tb, gain=0.07, pan=rng.uniform(-0.7, 0.7), send=0.55)

cue(CUE['fixWord'], 'merch -> merge')
for note, g in ((88, 1.0), (95, 0.5)):
    bus.add(bell(hz(note), 1.6, 0.9), CUE['fixWord'], gain=0.16 * g, pan=-0.1, send=0.55)

cue(CUE['setInType'], 'set in type')
for k, note in enumerate((86, 90, 93, 95, 98, 100)):
    bus.add(bell(hz(note), 1.0, 0.5, 0.6), CUE['setInType'] + k * 0.035, gain=0.07, pan=-0.6 + k * 0.24, send=0.6)

# Bar 4: the window comes up and the words land in it.
cue(CUE['windowRise'], 'window rises')
x = sweep_noise(0.5, 250, 1800) * np.hanning(int(0.5 * SR))
bus.add(x, CUE['windowRise'] - 0.15, gain=0.07, send=0.4)
cue(CUE['paste'], 'paste: success')
t = tt(0.4)
f = 300 * np.exp(-t / 0.05) + 120
x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.09)
bus.add(x, CUE['paste'], gain=0.35, send=0.2)
for k in range(12):
    bus.add(bell(hz(rng.choice([86, 88, 90, 93, 95, 98, 100])), 0.8, 0.35, 0.5), CUE['paste'] + 0.02 + rng.uniform(0, 0.5), gain=0.045, pan=rng.uniform(-0.8, 0.8), send=0.6)
bus.add(bell(hz(81), 2.0, 1.2), CUE['paste'], gain=0.12, send=0.5)

# Bar 5: each vocabulary fix pulls a pearl out of its jar.
cue(CUE['jarsRise'], 'jars rise')
x = sweep_noise(0.6, 200, 1200) * np.hanning(int(0.6 * SR))
bus.add(x, CUE['jarsRise'] - 0.2, gain=0.06, send=0.4)
for i, sw in enumerate(SCORE['swaps']):
    ts = CUE[sw['cue']]
    cue(ts, f'{sw["heard"]} -> {sw["fixed"]}')
    bus.add(bloop(hz(sw['pitch'] - 12), 0.22, 1.6), ts - 0.1, gain=0.12, pan=(i - 1) * 0.6, send=0.4)
    bus.add(bell(hz(sw['pitch']), 1.4, 0.8), ts + 0.05, gain=0.13, pan=(i - 1) * 0.6, send=0.55)

# Bar 6: a rush of bubbles, then the name.
cue(CUE['endCard'] - 0.35, 'bubble rush')
x = sweep_noise(0.7, 300, 6000) * np.linspace(0, 1, int(0.7 * SR)) ** 1.5
bus.add(x, CUE['endCard'] - 0.7, gain=0.12, send=0.4)
for k in range(28):
    bus.add(bloop(hz(rng.integers(74, 98)), 0.15, 1.9), CUE['endCard'] - 0.35 + rng.uniform(0, 1.2), gain=0.04, pan=rng.uniform(-0.9, 0.9), send=0.6)
cue(CUE['endCard'], 'end card: Delulu Talks')
x = filt(noise(3.0), 'bandpass', [2500, 11000]) * np.exp(-tt(3.0) / 0.7)
bus.add(x, CUE['endCard'], gain=0.05, send=0.6)
for note, g in ((74, 1.0), (81, 0.6), (86, 0.4)):
    bus.add(bell(hz(note), 2.5, 1.6), CUE['endCard'], gain=0.12 * g, send=0.55)
cue(CUE['tagline'], 'tagline')
bus.add(bell(hz(90), 1.6, 1.0, 0.7), CUE['tagline'], gain=0.06, pan=0.3, send=0.6)
cue(CUE['loopOut'], 'back to the start')
bus.add(bloop(hz(86), 0.3, 1.4), CUE['loopOut'], gain=0.07, send=0.7)

# ------------------------------------------------------------------- mix

ir = reverb_ir()
wet = np.stack([signal.fftconvolve(bus.wet[ch], ir[ch])[:N] for ch in range(2)])
mix = bus.dry + 0.55 * wet
# Glue: a soft clip, then normalise to -2.5 dBFS (about -14 LUFS) and fade the last moment.
mix = np.tanh(mix * 1.3) / 1.3
mix *= 10 ** (-2.5 / 20) / np.max(np.abs(mix))
fade = int(0.5 * SR)
mix[:, -fade:] *= np.linspace(1, 0, fade) ** 2
mix[:, : int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR))

out = Path(next((a for a in sys.argv[1:] if not a.startswith('--')), HERE / 'reel.wav'))
pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
with wave.open(str(out), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
cues.sort(key=lambda c: c['t'])
(HERE / 'cues.json').write_text(json.dumps(cues, indent=1) + '\n')
print(f'wrote {out} ({DUR:.2f} s) and cues.json ({len(cues)} cues)')

if '--spectrogram' in sys.argv:
    import matplotlib

    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(16, 5))
    ax.specgram(mix[0], NFFT=2048, Fs=SR, noverlap=1536, cmap='magma')
    ax.set_ylim(0, 8000)
    for c in cues:
        ax.axvline(c['t'], color='cyan', lw=0.6, alpha=0.6)
    fig.tight_layout()
    fig.savefig(HERE / 'spectrogram.png', dpi=110)
