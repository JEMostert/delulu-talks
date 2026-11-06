// Delulu Talks — the reel. 15 s, 1920x1080, 60 fps, 96 BPM: six bars of 2.5 s.
// Every frame is a pure function of time t, timed by score.json (shared with soundtrack.py).
// The ambient motion (light rays, drifting motes) repeats every 15 s and the last half second
// returns to the first frame, so the reel loops.
const Reel = (() => {
  const W = 1920, H = 1080, DUR = 15, TAU = Math.PI * 2;
  // The app's brand constants (ui/src/styles/tokens.css).
  const C = {
    abyss: '#030e1a', shell: '#06192b', ink: '#eaf6ff', foam: [117, 228, 255], coral: [255, 111, 134],
    seaglass: [95, 220, 191], amber: [246, 201, 121], lavender: [194, 173, 219], inkRgb: [234, 246, 255],
  };
  const NACRE = ['#ffc2d1', '#bfefff', '#d9c9f2', '#f6dfb0', '#c4f2e6'];
  const F = { display: 'Display', ui: 'UI', uiBold: 'UIBold', text: 'Text', spoken: 'Spoken' };
  let S, BEAT, CUE = {};

  // ------------------------------------------------------------------ math
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const map = (t, a, b) => clamp((t - a) / (b - a));
  const mix = (c1, c2, k) => c1.map((v, i) => lerp(v, c2[i], k));
  const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const E = {
    outExpo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
    inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    inOutSine: (k) => -(Math.cos(Math.PI * k) - 1) / 2,
    outCubic: (k) => 1 - Math.pow(1 - k, 3),
    inCubic: (k) => k * k * k,
    outBack: (k, s = 1.7) => 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2),
    spring: (k, f = 2.6, d = 6) => (k <= 0 ? 0 : 1 - Math.exp(-d * k) * Math.cos(f * Math.PI * k)),
  };
  const rand = (s) => { const x = Math.sin(s * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const at = (name) => CUE[name];
  // k from 0 to 1 over `len` seconds starting at cue (or seconds) a.
  const after = (t, a, len) => map(t, typeof a === 'string' ? at(a) : a, (typeof a === 'string' ? at(a) : a) + len);

  // ------------------------------------------------------------- drawing
  function font(ctx, size, family) { ctx.font = `${size}px "${family}"`; }
  function txt(ctx, s, x, y, o = {}) {
    ctx.save();
    font(ctx, o.size || 32, o.font || F.ui);
    ctx.fillStyle = o.color || C.ink;
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.base || 'alphabetic';
    ctx.letterSpacing = (o.spacing || 0) + 'px';
    if (o.alpha != null) ctx.globalAlpha *= clamp(o.alpha);
    if (o.shadow) { ctx.shadowColor = o.shadow; ctx.shadowBlur = o.blur || 24; }
    ctx.fillText(s, x, y);
    ctx.restore();
  }
  function measure(ctx, s, size, family, spacing = 0) {
    ctx.save(); font(ctx, size, family); ctx.letterSpacing = spacing + 'px';
    const w = ctx.measureText(s).width; ctx.restore(); return w;
  }
  function nacre(ctx, x0, y0, x1, y1, shift = 0) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    NACRE.forEach((c, i) => g.addColorStop(clamp((i / (NACRE.length - 1) + shift) % 1.0001), c));
    return g;
  }

  // ---------------------------------------------------------------- water
  const rays = document.createElement('canvas');
  rays.width = 120; rays.height = 68;
  function water(ctx, t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0d3552'); g.addColorStop(0.45, '#062038'); g.addColorStop(1, '#020b16');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // Light from the surface: slanted rays that sway once (or twice) per loop. They are drawn
    // small and scaled up, which softens their edges like light through moving water.
    const rc = rays.getContext('2d');
    rc.setTransform(1, 0, 0, 1, 0, 0); rc.clearRect(0, 0, rays.width, rays.height); rc.scale(rays.width / W, rays.height / H);
    for (let i = 0; i < 7; i++) {
      const sway = Math.sin((TAU * t) / DUR * (1 + (i % 2)) + i * 1.7);
      const x = 180 + i * 260 + sway * 40, w = 70 + rand(i + 3) * 120, lean = 260 + rand(i) * 180;
      const a = 0.05 + 0.05 * (0.5 + 0.5 * Math.sin((TAU * t) / DUR * 2 + i));
      const rg = rc.createLinearGradient(0, 0, 0, H * 0.95);
      rg.addColorStop(0, `rgba(159,233,255,${a})`); rg.addColorStop(1, 'rgba(159,233,255,0)');
      rc.fillStyle = rg;
      rc.beginPath(); rc.moveTo(x, -10); rc.lineTo(x + w, -10); rc.lineTo(x + w * 2.2 + lean, H); rc.lineTo(x + lean, H); rc.fill();
    }
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingQuality = 'high'; ctx.drawImage(rays, 0, 0, W, H);
    // A pool of light behind the stage.
    const pool = ctx.createRadialGradient(W / 2, H * 0.44, 0, W / 2, H * 0.44, 760);
    pool.addColorStop(0, 'rgba(117,228,255,0.10)'); pool.addColorStop(1, 'rgba(117,228,255,0)');
    ctx.fillStyle = pool; ctx.fillRect(0, 0, W, H);
    ctx.restore();
    // Marine snow drifting on closed paths, so frame 900 matches frame 0.
    for (let i = 0; i < 110; i++) {
      const depth = rand(i * 7.3), r = 0.8 + depth * 2.6;
      const ph = TAU * (t / DUR) * (1 + (i % 3)) + rand(i) * TAU;
      const x = rand(i * 1.9) * W + Math.sin(ph) * (30 + depth * 50);
      const yy = rand(i * 3.1) * H - Math.cos(ph) * (20 + depth * 30);
      ctx.fillStyle = `rgba(200,240,255,${0.08 + depth * 0.28})`;
      ctx.beginPath(); ctx.arc(x, yy, r, 0, TAU); ctx.fill();
    }
  }
  function vignette(ctx) {
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05);
    v.addColorStop(0, 'rgba(2,8,16,0)'); v.addColorStop(1, 'rgba(2,8,16,0.72)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }

  // ------------------------------------------------------------- bubbles
  // A burst of bubbles born at time t0 at (x, y): they wobble upward and fade.
  function bubbles(ctx, t, t0, x, y, n, seed, o = {}) {
    const age = t - t0; if (age < 0) return;
    const life = o.life || 1.6, spread = o.spread || 60, rise = o.rise || 260;
    for (let i = 0; i < n; i++) {
      const s = seed * 31 + i, li = life * (0.6 + rand(s) * 0.6), a = age - rand(s + 9) * (o.stagger || 0.15);
      if (a < 0 || a > li) continue;
      const k = a / li, r = (o.size || 7) * (0.35 + rand(s + 2) * 0.9) * (0.6 + 0.4 * E.outCubic(map(a, 0, 0.15)));
      const bx = x + (rand(s + 4) - 0.5) * spread * 2 + Math.sin(a * (5 + rand(s) * 4) + s) * 8 * k;
      const by = y + (rand(s + 5) - 0.5) * spread * 0.6 - rise * (a + 0.6 * a * a) * (0.6 + rand(s + 6) * 0.7);
      ctx.save(); ctx.globalAlpha *= (1 - k) * (o.alpha || 0.9);
      ctx.strokeStyle = 'rgba(210,245,255,0.85)'; ctx.lineWidth = Math.max(1, r * 0.18);
      ctx.beginPath(); ctx.arc(bx, by, r, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(190,240,255,0.12)'; ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath(); ctx.arc(bx - r * 0.35, by - r * 0.35, r * 0.22, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }
  // Success: a shockwave and a spray of tiny pearls, like the recording pill.
  function burst(ctx, t, t0, x, y, color, scale = 1) {
    const a = t - t0; if (a < 0 || a > 1.4) return;
    const k = a / 1.4;
    ctx.save();
    ctx.strokeStyle = rgba(color, (1 - E.outCubic(map(a, 0, 0.7))) * 0.9);
    ctx.lineWidth = 6 * (1 - map(a, 0, 0.7)) + 1;
    ctx.beginPath(); ctx.arc(x, y, scale * (90 + 260 * E.outExpo(map(a, 0, 0.7))), 0, TAU); ctx.stroke();
    for (let i = 0; i < 26; i++) {
      const ang = (i / 26) * TAU + rand(i) * 0.4, sp = scale * (180 + rand(i + 50) * 260);
      const d = sp * E.outExpo(k * 1.2) , r = scale * (3 + rand(i + 7) * 6) * (1 - k);
      const px = x + Math.cos(ang) * (scale * 80 + d), py = y + Math.sin(ang) * (scale * 80 + d) + 60 * k * k;
      pearlBead(ctx, px, py, r, NACRE[i % 4], 1 - k);
    }
    ctx.restore();
  }
  function pearlBead(ctx, x, y, r, tint, alpha = 1) {
    if (r <= 0.2 || alpha <= 0) return;
    ctx.save(); ctx.globalAlpha *= alpha;
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r * 1.05);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, tint); g.addColorStop(1, '#5f6889');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- pearl
  // Ported from the app's pearl (ui/src/pearl/draw.ts): nacre base, drifting iridescence,
  // depth, rim light in the state colour, and a highlight from the light above.
  const SHEEN = [C.lavender, C.foam, C.seaglass, [255, 179, 193]];
  function pearl(ctx, cx, cy, r, t, p) {
    const strength = Math.min(1, p.glow + p.level * p.voice * 0.55);
    // halo
    const outer = r * (1.6 + strength * 0.6);
    const halo = ctx.createRadialGradient(cx, cy, r * 0.95, cx, cy, outer);
    halo.addColorStop(0, rgba(p.halo, 0.75 * strength)); halo.addColorStop(0.3, rgba(p.halo, 0.3 * strength)); halo.addColorStop(1, rgba(p.halo, 0));
    ctx.fillStyle = halo; ctx.fillRect(cx - outer, cy - outer, outer * 2, outer * 2);
    // voice ripples, one per beat
    if (p.rings > 0.01) {
      ctx.lineWidth = 3;
      for (let i = 0; i < 3; i++) {
        const q = ((t / BEAT) % 1 + i / 3) % 1;
        ctx.strokeStyle = rgba(p.halo, (1 - q) * (1 - q) * p.rings * (0.25 + p.level * 0.6));
        ctx.beginPath(); ctx.arc(cx, cy, r * (1.04 + q * 0.9), 0, TAU); ctx.stroke();
      }
    }
    // the thinking orbit
    if (p.orbit > 0.01) {
      const head = t * 4.2; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(3, r * 0.04);
      for (let i = 0; i < 14; i++) {
        const a = head - i * 0.07;
        ctx.strokeStyle = rgba(p.halo, p.orbit * (1 - i / 14) * 0.95);
        ctx.beginPath(); ctx.arc(cx, cy, r * 1.22, a - 0.08, a); ctx.stroke();
      }
    }
    // body
    ctx.save();
    const wob = p.wobble * p.level;
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const th = (i / 96) * TAU;
      const rr = r * (1 + wob * (Math.sin(th * 3 + t * 9) * 0.6 + Math.sin(th * 5 - t * 7) * 0.4));
      const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath(); ctx.clip();
    const box = [cx - r * 1.3, cy - r * 1.3, r * 2.6, r * 2.6];
    const base = ctx.createRadialGradient(cx - r * 0.32, cy - r * 0.38, r * 0.02, cx, cy, r * 1.1);
    base.addColorStop(0, '#ffffff'); base.addColorStop(0.22, '#f3f1f8'); base.addColorStop(0.55, '#dcdcec'); base.addColorStop(0.85, '#9aa1c2'); base.addColorStop(1, '#5f6889');
    ctx.fillStyle = base; ctx.fillRect(...box);
    // one full turn per loop, so the last frame meets the first
    const spin = (TAU * t) / DUR + 0.6;
    const band = ctx.createConicGradient(spin, cx + r * 0.1, cy + r * 0.12);
    [...SHEEN, SHEEN[0]].forEach((c, i, all) => band.addColorStop(i / (all.length - 1), rgba(c, 0.85)));
    ctx.globalCompositeOperation = 'overlay'; ctx.fillStyle = band; ctx.fillRect(...box);
    ctx.globalCompositeOperation = 'source-over';
    SHEEN.forEach((c, i) => {
      const ang = -spin * 2 + (i * TAU) / SHEEN.length;
      const x = cx + Math.cos(ang) * r * 0.5, y = cy + Math.sin(ang) * r * 0.5;
      const pool = ctx.createRadialGradient(x, y, 0, x, y, r * 0.62);
      pool.addColorStop(0, rgba(c, 0.45)); pool.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = pool; ctx.fillRect(...box);
    });
    const depth = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.25, r * 0.45, cx, cy, r * 1.08);
    depth.addColorStop(0, 'rgba(6,25,43,0)'); depth.addColorStop(1, 'rgba(6,25,43,0.5)');
    ctx.fillStyle = depth; ctx.fillRect(...box);
    const rim = ctx.createRadialGradient(cx + r * 0.25, cy + r * 0.55, r * 0.1, cx + r * 0.25, cy + r * 0.55, r * 0.9);
    rim.addColorStop(0, rgba(p.halo, 0.35 + p.glow * 0.35 + p.level * p.voice * 0.3)); rim.addColorStop(1, rgba(p.halo, 0));
    ctx.fillStyle = rim; ctx.fillRect(...box);
    ctx.translate(cx - r * 0.36, cy - r * 0.44); ctx.rotate(-0.65); ctx.scale(1, 0.62);
    const spec = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.34);
    spec.addColorStop(0, 'rgba(255,255,255,0.95)'); spec.addColorStop(0.35, 'rgba(255,255,255,0.7)'); spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec; ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.985, 0, TAU); ctx.lineWidth = Math.max(1.5, r * 0.018);
    const edge = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    edge.addColorStop(0, 'rgba(255,255,255,0.05)'); edge.addColorStop(1, rgba(p.halo, 0.55 + p.glow * 0.3));
    ctx.strokeStyle = edge; ctx.stroke(); ctx.restore();
  }

  // ---------------------------------------------------------------- speech
  // Syllable onsets (seconds) and the voice level, from score.json.
  let SYL = [], WORDS = [], LIVE = [];
  function voiceLevel(t) {
    let v = 0;
    for (const s of SYL) {
      const a = t - s.t; if (a < -0.02 || a > 0.5) continue;
      const env = a < 0 ? 0 : Math.min(1, a / 0.025) * Math.exp(-a / 0.11);
      v = Math.max(v, env * s.amp);
    }
    return v;
  }

  // The pearl's state: where it is, how big, and which colour it speaks in.
  const CALM = { halo: C.lavender, glow: 0.42, voice: 0, wobble: 0, sheen: 0.12, orbit: 0, rings: 0 };
  function pearlState(t) {
    const kd = at('keyDown'), ku = at('keyUp'), ps = at('paste'), jr = at('jarsRise'), ec = at('endCard'), lo = at('loopOut');
    const home = { x: W / 2, y: 470, r: 132 };
    let pos = home;
    const talk = { x: W / 2, y: 300, r: 104 };
    const above = { x: W / 2, y: 150, r: 58 };
    const end = { x: W / 2, y: 312, r: 112 };
    const blend = (a, b, k) => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), r: lerp(a.r, b.r, k) });
    pos = blend(home, talk, E.inOut(after(t, kd - 0.3, 0.55)));
    if (t > at('windowRise') - 0.5) pos = blend(talk, above, E.inOut(after(t, at('windowRise') - 0.5, 0.5)));
    if (t > jr - 0.2) pos = blend(above, { x: W / 2, y: 150, r: 54 }, E.inOut(after(t, jr - 0.2, 0.6)));
    if (t > ec - 0.3) pos = blend({ x: W / 2, y: 150, r: 54 }, end, E.outCubic(after(t, ec - 0.3, 0.8)));
    if (t > lo) pos = blend(end, home, E.inOutSine(after(t, lo, DUR - lo)));
    // colour states
    let p = { ...CALM };
    const rec = { halo: C.coral, glow: 0.62, voice: 1, wobble: 0.05, sheen: 0.5, orbit: 0, rings: 1 };
    const think = { halo: C.foam, glow: 0.6, voice: 0, wobble: 0, sheen: 0.3, orbit: 1, rings: 0 };
    const ok = { halo: C.seaglass, glow: 0.78, voice: 0, wobble: 0, sheen: 0.3, orbit: 0, rings: 0 };
    const blendP = (a, b, k) => ({
      halo: mix(a.halo, b.halo, k), glow: lerp(a.glow, b.glow, k), voice: lerp(a.voice, b.voice, k), wobble: lerp(a.wobble, b.wobble, k),
      sheen: lerp(a.sheen, b.sheen, k), orbit: lerp(a.orbit, b.orbit, k), rings: lerp(a.rings, b.rings, k),
    });
    if (t >= kd - 0.08) p = blendP(CALM, rec, after(t, kd - 0.08, 0.16));
    if (t >= ku) p = blendP(rec, think, after(t, ku, 0.2));
    if (t >= ps) p = blendP(think, ok, after(t, ps, 0.12));
    if (t >= jr) p = blendP(ok, { ...CALM, halo: C.foam, glow: 0.5 }, after(t, jr, 0.5));
    if (t >= ec - 0.2) p = blendP({ ...CALM, halo: C.foam, glow: 0.5 }, { ...CALM, glow: 0.6, sheen: 0.25 }, after(t, ec - 0.2, 0.6));
    if (t >= lo) p = blendP({ ...CALM, glow: 0.6, sheen: 0.25 }, CALM, after(t, lo, DUR - lo));
    p.level = voiceLevel(t);
    return { pos, p };
  }

  // ----------------------------------------------------------------- keys
  function keycap(ctx, x, y, w, h, label, down, glow) {
    ctx.save();
    const dy = down * 10;
    // base (the side of the key)
    ctx.fillStyle = '#041626'; ctx.beginPath(); ctx.roundRect(x, y + 14, w, h, 22); ctx.fill();
    ctx.strokeStyle = 'rgba(160,225,255,0.18)'; ctx.lineWidth = 1.5; ctx.stroke();
    // halo when held
    if (glow > 0) {
      ctx.shadowColor = rgba(C.coral, 0.75 * glow); ctx.shadowBlur = 48;
    }
    const top = ctx.createLinearGradient(0, y + dy, 0, y + dy + h);
    top.addColorStop(0, rgba(mix([22, 58, 84], [120, 40, 64], glow * 0.6), 1)); top.addColorStop(1, rgba(mix([11, 37, 57], [70, 20, 40], glow * 0.6), 1));
    ctx.fillStyle = top; ctx.beginPath(); ctx.roundRect(x, y + dy, w, h, 22); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2; ctx.strokeStyle = nacre(ctx, x, y, x + w, y + h); ctx.globalAlpha = 0.55 + glow * 0.45; ctx.stroke();
    ctx.globalAlpha = 1;
    txt(ctx, label, x + w / 2, y + dy + h / 2 + 2, { size: 40, font: F.uiBold, align: 'center', base: 'middle', color: glow > 0.5 ? '#ffe3ea' : C.ink });
    ctx.restore();
  }
  function keys(ctx, t) {
    const rise = E.spring(after(t, 'keysRise', 0.9));
    const gone = E.inOut(after(t, at('keyUp') + 0.25, 0.35));
    if (rise <= 0 || gone >= 1) return;
    const down = E.outCubic(after(t, at('keyDown') - 0.04, 0.08)) * (1 - E.outBack(after(t, 'keyUp', 0.22)));
    const glow = after(t, at('keyDown') - 0.04, 0.12) * (1 - after(t, 'keyUp', 0.15));
    const y = lerp(1140, 812, rise) + gone * 60;
    ctx.save(); ctx.globalAlpha = rise * (1 - gone);
    const gap = 36, w1 = 230, w2 = 130, h = 112, x0 = W / 2 - (w1 + w2 + gap) / 2;
    keycap(ctx, x0, y, w1, h, 'Super', down, glow);
    keycap(ctx, x0 + w1 + gap, y, w2, h, 'Z', down, glow);
    ctx.restore();
  }

  // -------------------------------------------------------------- caption
  function caption(ctx, t, s, a, b, y = 1004) {
    const k = after(t, a, 0.35) * (1 - after(t, b - 0.3, 0.3));
    if (k <= 0) return;
    txt(ctx, s, W / 2, y + 14 * (1 - E.outCubic(k)), { size: 40, font: F.ui, align: 'center', alpha: k * 0.82, color: C.ink });
  }

  // -------------------------------------------------------------- sentence
  // The raw words, as said, and what cleanup makes of each one.
  // kind: keep | filler | takeback | fix ; fixed: the cleaned word.
  const PLAN = {
    so: { fixed: 'So' }, um: { kind: 'filler' }, the: {}, merch: { kind: 'fix', fixed: 'merge' }, conflict: {}, is: {}, on: {},
    'monday,': { kind: 'takeback' }, no: { kind: 'takeback' }, 'sorry,': { kind: 'takeback' }, tuesday: { fixed: 'Tuesday.' },
  };
  const SPOKEN_SIZE = 64, TEXT_SIZE = 80, LINE_Y = 584, LINE_UP = 318;
  // The line rises above the chat window while it comes up.
  const lineY = (t) => lerp(LINE_Y, LINE_UP, E.inOut(after(t, at('windowRise') - 0.35, 0.55)));
  function sentence(ctx, t) {
    const kd = at('keyDown'), ku = at('keyUp');
    if (t < kd) return;
    const tPop = at('popFiller'), tLift = at('liftTakeBack'), tFix = at('fixWord'), tSet = at('setInType');
    const tWin = at('windowRise'), tPaste = at('paste');
    const set = E.inOut(after(t, tSet, 0.45));
    const size = lerp(SPOKEN_SIZE, TEXT_SIZE, set);
    const space = lerp(size * 0.27, measure(ctx, ' ', size, F.text), set);
    // Width of each word now; collapsing words shrink to zero width.
    const items = WORDS.map((w, i) => {
      const plan = PLAN[w.word] || {};
      let shown = 1, lift = 0, alpha = 1, text = w.word;
      const appear = after(t, w.t - 0.02, 0.18);
      alpha = appear;
      if (plan.kind === 'filler') { const k = after(t, tPop + 0.08, 0.32); shown = 1 - E.inOut(k); alpha *= 1 - map(t, tPop, tPop + 0.06); }
      if (plan.kind === 'takeback') { const k = after(t, tLift + 0.22, 0.5); shown = 1 - E.inOut(k); lift = E.inCubic(after(t, tLift + 0.12, 0.6)); alpha *= 1 - after(t, tLift + 0.2, 0.45); }
      const fixK = plan.kind === 'fix' ? after(t, tFix, 0.28) : 0;
      const fixedText = plan.fixed || w.word.replace(/,$/, '');
      const wSpoken = measure(ctx, w.word, size, F.spoken), wText = measure(ctx, fixedText, size, F.text);
      const width = lerp(plan.kind === 'fix' ? lerp(wSpoken, measure(ctx, 'merge', size, F.spoken), E.inOut(fixK)) : wSpoken, wText, set);
      return { w, plan, shown, lift, alpha, text, fixedText, width, fixK, i };
    });
    const total = items.reduce((s, it, i) => s + (it.width + (i ? space : 0)) * it.shown, 0);
    // While speaking, the line is laid out left to right from where it will end up at full length.
    let x = W / 2 - total / 2;
    // Fly into the composer on paste.
    const fly = E.inOut(after(t, tPaste - 0.42, 0.42));
    const gone = after(t, at('jarsRise') - 0.4, 0.3);
    const ui = composerAnchor(t);
    const LY = lineY(t);
    ctx.save();
    if (fly > 0) {
      // Scale the line about its left edge toward the composer text position.
      const sc = lerp(1, ui.size / TEXT_SIZE, fly);
      ctx.translate(lerp(x, ui.x, fly), lerp(LY, ui.y, fly)); ctx.scale(sc, sc); ctx.translate(-x, -LY);
      ctx.globalAlpha = 1 - after(t, tPaste - 0.03, 0.05);
    }
    if (ctx.globalAlpha <= 0 || gone >= 1) { ctx.restore(); return; }
    for (const it of items) {
      const { w, plan } = it;
      const width = it.width * it.shown;
      if (it.alpha > 0.001 && it.shown > 0.01) {
        const y = LY - it.lift * 120 - (1 - E.outCubic(after(t, w.t - 0.02, 0.25))) * 22;
        const spokenA = it.alpha * (1 - set) * 0.8, textA = it.alpha * set;
        ctx.save(); ctx.globalAlpha *= 1;
        ctx.translate(x + width / 2, y); ctx.scale(it.shown, it.shown);
        // spoken (italic, lowercase)
        let spokenWord = w.word;
        if (plan.kind === 'fix') {
          // merch flips to merge: the old word folds away, the new one unfolds in sea glass.
          const k = E.inOut(it.fixK);
          const sy1 = Math.max(0, 1 - k * 2), sy2 = Math.max(0, k * 2 - 1);
          if (sy1 > 0) { ctx.save(); ctx.scale(1, sy1); txt(ctx, 'merch', 0, 0, { size, font: F.spoken, align: 'center', color: C.ink, alpha: spokenA }); ctx.restore(); }
          if (sy2 > 0) {
            ctx.save(); ctx.scale(1, sy2);
            const glowK = 1 - after(t, tFix + 0.3, 0.9);
            txt(ctx, 'merge', 0, 0, { size, font: F.spoken, align: 'center', color: rgba(mix(C.inkRgb, C.seaglass, glowK)), alpha: spokenA / 0.8, shadow: rgba(C.seaglass, glowK * 0.9), blur: 30 });
            ctx.restore();
          }
          spokenWord = null;
        }
        if (spokenWord && spokenA > 0) {
          const strike = plan.kind === 'takeback' ? E.outCubic(after(t, tLift, 0.18)) : 0;
          const pop = plan.kind === 'filler' ? E.outBack(after(t, tPop - 0.06, 0.1)) * 0.18 : 0;
          ctx.save(); ctx.scale(1 + pop, 1 + pop);
          const col = plan.kind === 'takeback' ? rgba(mix(C.inkRgb, C.coral, strike)) : plan.kind === 'filler' ? rgba(mix(C.inkRgb, C.amber, after(t, tPop - 0.12, 0.1))) : C.ink;
          txt(ctx, spokenWord, 0, 0, { size, font: F.spoken, align: 'center', color: col, alpha: spokenA });
          if (strike > 0) {
            ctx.strokeStyle = rgba(C.coral, it.alpha * 0.95); ctx.lineWidth = 5; ctx.lineCap = 'round';
            const ww = it.width / 2 + 6;
            ctx.beginPath(); ctx.moveTo(-ww, -size * 0.28); ctx.lineTo(-ww + 2 * ww * strike, -size * 0.28); ctx.stroke();
          }
          ctx.restore();
        }
        if (textA > 0) {
          const tw = it.fixedText;
          const glowK = plan.kind === 'fix' ? 1 - after(t, tFix + 0.3, 0.9) : 0;
          txt(ctx, tw, 0, 0, { size, font: F.text, align: 'center', color: rgba(mix(C.inkRgb, C.seaglass, glowK)), alpha: textA });
        }
        ctx.restore();
      }
      LIVE[it.i] = x + width / 2;
      x += (it.width + space) * it.shown;
    }
    ctx.restore();
  }
  // The positions where each word sits while spoken, for beads and bubbles.
  function wordCenters(ctx, t) {
    const size = SPOKEN_SIZE, space = size * 0.27;
    const ws = WORDS.map((w) => measure(ctx, w.word, size, F.spoken));
    const total = ws.reduce((a, b) => a + b, 0) + space * (ws.length - 1);
    let x = W / 2 - total / 2;
    return ws.map((w) => { const c = { x0: x, x1: x + w, cx: x + w / 2 }; x += w + space; return c; });
  }

  // ---------------------------------------------------------------- beads
  // While the key is held, the voice strings itself as pearls on a silk thread, like the pill.
  function beads(ctx, t) {
    const kd = at('keyDown'), ku = at('keyUp');
    if (t < kd - 0.1 || t > ku + 1.2) return;
    const centers = wordCenters(ctx, t);
    const y = 690;
    const x0 = centers[0].x0 - 20, x1 = centers[centers.length - 1].x1 + 20;
    const head = clamp(t < ku ? map(t, kd, ku - BEAT * 0.25) : 1);
    const drop = E.inCubic(after(t, ku + 0.1, 0.9));
    ctx.save(); ctx.globalAlpha = (1 - drop) * after(t, kd - 0.1, 0.2);
    // thread
    const hx = lerp(x0, x1, head);
    const th = ctx.createLinearGradient(x0, 0, x1, 0);
    th.addColorStop(0, 'rgba(255,170,196,0.15)'); th.addColorStop(head, 'rgba(255,170,196,0.6)'); th.addColorStop(Math.min(1, head + 0.001), 'rgba(255,170,196,0)');
    ctx.strokeStyle = th; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y + drop * 80); ctx.stroke();
    // one bead every few pixels of the line, sized by the voice at the time it was strung
    const step = 30;
    for (let x = x0 + 8; x < x1 - 4; x += step) {
      const k = (x - x0) / (x1 - x0);
      if (k > head) break;
      const tb = lerp(kd, ku - BEAT * 0.25, k);
      const lv = voiceLevel(tb);
      const r = 4 + lv * 11 + (rand(x) - 0.5) * 1.5;
      const age = t - tb;
      const grow = E.outBack(clamp(age / 0.18));
      const sink = drop * (60 + rand(x * 3) * 90);
      pearlBead(ctx, x, y + sink - lv * 0, r * grow, NACRE[Math.floor(rand(x * 0.37) * 4)], 1);
    }
    // the bright head of the string
    if (head < 1 && t < ku) {
      const hg = ctx.createRadialGradient(hx, y, 0, hx, y, 36);
      hg.addColorStop(0, rgba(C.coral, 0.7)); hg.addColorStop(1, rgba(C.coral, 0));
      ctx.fillStyle = hg; ctx.fillRect(hx - 36, y - 36, 72, 72);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------- the topic
  function topicChip(ctx, t) {
    const a = after(t, at('fixWord') + 0.05, 0.3) * (1 - after(t, at('windowRise') - 0.4, 0.2));
    if (a <= 0) return;
    const label = 'Programming', size = 30, pad = 22;
    const tw = measure(ctx, label, size, F.ui), w = tw + pad * 2 + 30, h = 54;
    const x = W / 2 - w / 2, y = 680 + 16 * (1 - E.outBack(after(t, at('fixWord') + 0.05, 0.4)));
    ctx.save(); ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(95,220,191,0.12)'; ctx.strokeStyle = 'rgba(95,220,191,0.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 27); ctx.fill(); ctx.stroke();
    pearlBead(ctx, x + pad + 8, y + h / 2, 9, '#c4f2e6');
    txt(ctx, label, x + pad + 30, y + h / 2 + 1, { size, font: F.ui, base: 'middle', color: '#c9f6ea' });
    ctx.restore();
  }

  // -------------------------------------------------------------- window
  // "The app you were using": a chat window with a message box and a blinking cursor.
  function composerAnchor(t) {
    const r = windowRect(t);
    return { x: r.x + 58, y: r.y + r.h - 68, size: 42 };
  }
  function windowRect(t) {
    const k = E.outCubic(after(t, at('windowRise') - 0.15, 0.6));
    const out = E.inCubic(after(t, at('jarsRise') - 0.55, 0.4));
    const w = 1120, h = 450;
    return { x: W / 2 - w / 2, y: 430 + (1 - k) * 420 + out * 120, w, h, a: k * (1 - out) };
  }
  function appWindow(ctx, t) {
    const r = windowRect(t);
    if (r.a <= 0.001) return;
    ctx.save(); ctx.globalAlpha = r.a;
    ctx.shadowColor = 'rgba(0,6,14,0.6)'; ctx.shadowBlur = 80; ctx.shadowOffsetY = 30;
    ctx.fillStyle = 'rgba(10,34,54,0.92)'; ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 26); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = 2; ctx.strokeStyle = nacre(ctx, r.x, r.y, r.x + r.w, r.y + r.h); ctx.globalAlpha = r.a * 0.45; ctx.stroke(); ctx.globalAlpha = r.a;
    // title bar
    ctx.fillStyle = 'rgba(234,246,255,0.04)'; ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, 74, [26, 26, 0, 0]); ctx.fill();
    txt(ctx, '#release', r.x + 40, r.y + 47, { size: 30, font: F.uiBold, color: C.ink, alpha: 0.9 });
    // window buttons, right side like most Linux desktops
    for (let i = 0; i < 3; i++) { ctx.fillStyle = 'rgba(234,246,255,0.16)'; ctx.beginPath(); ctx.arc(r.x + r.w - 44 - i * 40, r.y + 37, 9, 0, TAU); ctx.fill(); }
    // an earlier message
    const my = r.y + 150;
    ctx.fillStyle = rgba(C.amber, 0.9); ctx.beginPath(); ctx.arc(r.x + 70, my, 30, 0, TAU); ctx.fill();
    txt(ctx, 'M', r.x + 70, my + 1, { size: 30, font: F.uiBold, align: 'center', base: 'middle', color: '#3a2a08' });
    txt(ctx, 'Mara', r.x + 122, my - 10, { size: 28, font: F.uiBold, color: C.ink, alpha: 0.95 });
    txt(ctx, 'Is the merge still happening Monday?', r.x + 122, my + 34, { size: 36, font: F.ui, color: C.ink, alpha: 0.78 });
    // the message box
    const bx = r.x + 30, by = r.y + r.h - 124, bw = r.w - 60, bh = 92;
    const pasted = t >= at('paste') - 0.03;
    const pasteA = after(t, at('paste') - 0.03, 0.05);
    const flash = 1 - after(t, at('paste'), 0.9);
    ctx.fillStyle = 'rgba(3,14,26,0.55)'; ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 18); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = pasted ? rgba(C.seaglass, 0.35 + 0.6 * flash) : 'rgba(117,228,255,0.35)'; ctx.stroke();
    const tx = r.x + 58, ty = r.y + r.h - 68;
    let cx = tx;
    if (pasted) {
      const s = 'So the merge conflict is on Tuesday.';
      txt(ctx, s, tx, ty, { size: 42, font: F.text, color: C.ink, alpha: pasteA });
      cx = tx + measure(ctx, s, 42, F.text) + 6;
    } else {
      txt(ctx, 'Message #release', tx + 8, ty, { size: 32, font: F.ui, color: C.ink, alpha: 0.32 * (1 - after(t, at('paste') - 0.4, 0.2)) });
    }
    // blinking cursor, on the beat
    const blink = ((t / BEAT) % 1) < 0.55 ? 1 : 0.15;
    ctx.fillStyle = rgba(C.foam, blink); ctx.fillRect(cx, ty - 38, 3, 50);
    ctx.restore();
    if (pasted) {
      // A splash of light along the pasted text.
      const k = after(t, at('paste'), 0.6);
      const sw = measure(ctx, 'So the merge conflict is on Tuesday.', 42, F.text);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const gx = tx + sw * E.outCubic(k);
      const g = ctx.createRadialGradient(gx, ty - 12, 0, gx, ty - 12, 120);
      g.addColorStop(0, rgba(C.seaglass, 0.45 * (1 - k))); g.addColorStop(1, rgba(C.seaglass, 0));
      ctx.fillStyle = g; ctx.fillRect(gx - 120, ty - 132, 240, 240); ctx.restore();
    }
  }

  // ---------------------------------------------------------------- jars
  // Vocabulary shelves, drawn as glass jars on a reef ledge, like the Cleanup page.
  const JARS = [
    { shelf: 'Programming', terms: ['T3 Code', 'Tauri', 'Rust'], tint: C.foam },
    { shelf: 'Gaming & Discord', terms: ['nerf', 'Steam Deck', 'GG'], tint: C.lavender },
    { shelf: 'Twitch & Streaming', terms: ['OBS', 'VOD', 'raid'], tint: C.coral },
  ];
  function jar(ctx, t, cx, base, j, i, lit) {
    const w = 300, h = 300, x = cx - w / 2, y = base - h;
    ctx.save();
    // glow when used
    if (lit > 0) {
      const g = ctx.createRadialGradient(cx, y + h * 0.55, 10, cx, y + h * 0.55, 300);
      g.addColorStop(0, rgba(j.tint, 0.35 * lit)); g.addColorStop(1, rgba(j.tint, 0));
      ctx.fillStyle = g; ctx.fillRect(cx - 300, y - 150, 600, 600);
    }
    // body
    ctx.beginPath(); ctx.roundRect(x, y + 36, w, h - 36, [40, 40, 54, 54]);
    const body = ctx.createLinearGradient(x, 0, x + w, 0);
    body.addColorStop(0, 'rgba(160,225,255,0.16)'); body.addColorStop(0.5, 'rgba(160,225,255,0.05)'); body.addColorStop(1, 'rgba(160,225,255,0.13)');
    ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = `rgba(200,240,255,${0.35 + lit * 0.4})`; ctx.stroke();
    // a vertical shine on the glass
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.beginPath(); ctx.roundRect(x + 26, y + 70, 16, h - 120, 8); ctx.fill();
    // lid, mother-of-pearl
    ctx.fillStyle = nacre(ctx, x, y, x + w, y + 40, 0.1 * i); ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.roundRect(x + 24, y + 6, w - 48, 38, 12); ctx.fill(); ctx.globalAlpha = 1;
    // terms floating inside
    j.terms.forEach((term, k) => {
      const fy = y + 118 + k * 62 + Math.sin(TAU * t / DUR * 2 + k + i) * 5;
      const tw = measure(ctx, term, 28, F.ui);
      ctx.fillStyle = 'rgba(234,246,255,0.08)'; ctx.beginPath(); ctx.roundRect(cx - tw / 2 - 18, fy - 24, tw + 36, 46, 23); ctx.fill();
      txt(ctx, term, cx, fy + 1, { size: 28, font: F.ui, align: 'center', base: 'middle', color: C.ink, alpha: k === 0 ? 0.95 : 0.7 });
    });
    // shelf name under the jar
    txt(ctx, j.shelf, cx, base + 58, { size: 30, font: F.ui, align: 'center', color: C.ink, alpha: 0.75 });
    ctx.restore();
  }
  function jarsScene(ctx, t) {
    const jr = at('jarsRise'), ec = at('endCard');
    const k = E.spring(after(t, jr - 0.12, 1.0));
    const out = E.inOut(after(t, ec - 0.55, 0.45));
    if (k <= 0 || out >= 1) return;
    const base = lerp(1300, 820, k) + out * 220;
    ctx.save(); ctx.globalAlpha = clamp(k * 1.2) * (1 - out);
    // the ledge
    const lg = ctx.createLinearGradient(0, base, 0, base + 20);
    lg.addColorStop(0, 'rgba(61,111,140,0.9)'); lg.addColorStop(1, 'rgba(11,37,57,0.0)');
    ctx.fillStyle = lg; ctx.beginPath(); ctx.roundRect(260, base, W - 520, 20, 10); ctx.fill();
    S.swaps.forEach((sw, i) => {
      const cx = W / 2 + (i - 1) * 440;
      const ts = at(sw.cue);
      const lit = after(t, ts - 0.05, 0.1) * (1 - after(t, ts + 0.2, 0.7));
      jar(ctx, t, cx, base, JARS[i], i, lit);
      // what was heard, then the fix pulled from the jar
      const heardA = after(t, ts - 0.45, 0.25);
      const swapK = after(t, ts + 0.05, 0.28);
      const y = base - 420;
      if (heardA > 0) {
        const go = after(t, ts - 0.04, 0.12);
        txt(ctx, sw.heard, cx, y - 26 * go, { size: 54, font: F.spoken, align: 'center', color: C.ink, alpha: heardA * (1 - go) * 0.75 });
      }
      if (swapK > 0) {
        // a pearl flies from the jar to the word
        const fk = after(t, ts - 0.12, 0.2);
        if (fk > 0 && fk < 1) pearlBead(ctx, cx, lerp(base - 200, y - 18, E.inCubic(fk)), 12, '#ffffff', 1);
        const glow = 1 - after(t, ts + 0.15, 0.8);
        const s = 0.85 + 0.15 * E.outBack(swapK);
        ctx.save(); ctx.translate(cx, y); ctx.scale(s, s);
        txt(ctx, sw.fixed, 0, 0, { size: 62, font: F.text, align: 'center', color: rgba(mix(C.inkRgb, j_tint(i), glow * 0.8)), alpha: E.outCubic(swapK), shadow: rgba(j_tint(i), glow * 0.8), blur: 28 });
        ctx.restore();
      }
    });
    ctx.restore();
  }
  const j_tint = (i) => JARS[i].tint;

  // ------------------------------------------------------------ end card
  function endCard(ctx, t) {
    const ec = at('endCard'), lo = at('loopOut');
    const k = E.outCubic(after(t, ec + 0.05, 0.7));
    const out = E.inOut(after(t, lo, 0.45));
    if (k <= 0 || out >= 1) return;
    const a = k * (1 - out);
    const size = 190;
    const title = 'Delulu Talks';
    const sp = lerp(40, -2, E.outExpo(after(t, ec + 0.05, 1.0)));
    const tw = measure(ctx, title, size, F.display, sp);
    ctx.save(); ctx.globalAlpha = a;
    font(ctx, size, F.display); ctx.letterSpacing = sp + 'px'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const x = W / 2 - tw / 2, y = 640;
    ctx.fillStyle = C.ink; ctx.fillText(title, x, y + 20 * (1 - k));
    // a mother-of-pearl sheen sweeps across the name once
    const sweep = after(t, ec + 0.35, 1.3);
    if (sweep > 0 && sweep < 1) {
      ctx.save(); ctx.globalCompositeOperation = 'source-atop';
      const sx = lerp(x - 400, x + tw + 400, E.inOutSine(sweep));
      const g = ctx.createLinearGradient(sx - 260, 0, sx + 260, 0);
      g.addColorStop(0, 'rgba(255,194,209,0)'); g.addColorStop(0.3, 'rgba(255,194,209,0.9)'); g.addColorStop(0.5, 'rgba(191,239,255,1)'); g.addColorStop(0.7, 'rgba(246,223,176,0.9)'); g.addColorStop(1, 'rgba(246,223,176,0)');
      ctx.fillStyle = g; ctx.fillText(title, x, y + 20 * (1 - k));
      ctx.restore();
    }
    ctx.restore();
    const tg = after(t, 'tagline', 0.4) * (1 - out);
    txt(ctx, 'Hold a key, say it, and it’s typed.', W / 2, 748 + 12 * (1 - E.outCubic(tg)), { size: 58, font: F.spoken, align: 'center', color: C.ink, alpha: tg });
    const ll = after(t, 'localLine', 0.4) * (1 - out);
    txt(ctx, 'Local dictation for Linux. Nothing you say leaves your computer.', W / 2, 850 + 10 * (1 - E.outCubic(ll)), { size: 34, font: F.ui, align: 'center', color: C.ink, alpha: ll * 0.7 });
  }

  // --------------------------------------------------------------- frame
  function scene(ctx, t) {
    ctx.save();
    water(ctx, t);
    const { pos, p } = pearlState(t);
    jarsScene(ctx, t);
    appWindow(ctx, t);
    pearl(ctx, pos.x, pos.y, pos.r, t, p);
    beads(ctx, t);
    sentence(ctx, t);
    topicChip(ctx, t);
    keys(ctx, t);
    // bubbles where filler pops and the take-back lifts away
    // (LIVE holds where each word is on this frame, so the bubbles leave from the word itself)
    if (t > at('popFiller')) bubbles(ctx, t, at('popFiller'), LIVE[1], LINE_Y - 30, 14, 1, { size: 9, spread: 40, rise: 200, life: 1.2 });
    if (t > at('liftTakeBack') + 0.2) bubbles(ctx, t, at('liftTakeBack') + 0.2, LIVE[8], LINE_Y - 100, 26, 2, { size: 10, spread: 170, rise: 230, life: 1.6 });
    // the success burst around the pearl as the words land
    burst(ctx, t, at('paste'), pos.x, pos.y, C.seaglass, 0.8);
    S.swaps.forEach((sw, i) => bubbles(ctx, t, at(sw.cue), W / 2 + (i - 1) * 440, 520, 10, 10 + i, { size: 8, spread: 50, rise: 220, life: 1.1 }));
    // the bubble rush that clears the stage for the end card
    bubbles(ctx, t, at('endCard') - 0.35, W / 2, 1150, 90, 40, { size: 16, spread: 900, rise: 900, life: 1.4, stagger: 0.35, alpha: 0.7 });
    caption(ctx, t, 'Hold Super+Z and talk.', at('keysRise') + 0.3, at('keyUp'));
    caption(ctx, t, 'Let go. Cleanup tidies what you said.', at('keyUp') + 0.1, at('windowRise'));
    caption(ctx, t, 'Then it’s typed into the app you were using.', at('windowRise') + 0.4, at('jarsRise'));
    caption(ctx, t, 'Your names and terms, spelled your way.', at('jarsRise') + 0.3, at('endCard'));
    endCard(ctx, t);
    vignette(ctx);
    ctx.restore();
  }

  const scratch = document.createElement('canvas');
  scratch.width = W; scratch.height = H;
  function renderFrame(out, i, sub = 1) {
    const ctx = out.getContext('2d');
    const fps = S.fps;
    if (sub <= 1) { scene(ctx, (i / fps) % DUR); return; }
    const sctx = scratch.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    for (let s = 0; s < sub; s++) {
      // sub-frames spread over a 180° shutter, centred on the frame time
      const t = ((i + (s / sub - 0.5) * 0.5) / fps + DUR) % DUR;
      sctx.setTransform(1, 0, 0, 1, 0, 0);
      scene(sctx, t);
      ctx.globalAlpha = 1 / (s + 1);
      ctx.drawImage(scratch, 0, 0);
    }
    ctx.globalAlpha = 1;
  }

  async function load() {
    S = await (await fetch('score.json')).json();
    BEAT = 60 / S.bpm;
    for (const [k, v] of Object.entries(S.cues)) CUE[k] = v * BEAT;
    const step = S.speech.step * BEAT;
    let n = 0;
    WORDS = [];
    SYL = [];
    for (const w of S.speech.words) {
      WORDS.push({ word: w.word, t: S.speech.start * BEAT + n * step });
      for (const s of w.syllables) {
        SYL.push({ t: S.speech.start * BEAT + n * step, amp: 0.65 + 0.35 * rand(n + 1) });
        n++;
      }
    }
    const faces = [['Display', 'Display.ttf'], ['UI', 'UI.ttf'], ['UIBold', 'UIBold.ttf'], ['Text', 'Text.ttf'], ['Spoken', 'Spoken.ttf']];
    for (const [name, file] of faces) {
      const f = new FontFace(name, `url(fonts/${file})`);
      await f.load(); document.fonts.add(f);
    }
  }

  return { load, renderFrame, W, H, DUR, get fps() { return S.fps; } };
})();
