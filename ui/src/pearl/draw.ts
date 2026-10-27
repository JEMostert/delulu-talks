import { edge, palette, rgba, type PearlParams, type Rgb } from "./model";

export type Frame = {
  /** Seconds since the pearl appeared. */
  t: number;
  /** Smoothed mic level, 0..1. */
  level: number;
  params: PearlParams;
};

const sheenColors: Rgb[] = [
  palette.lavender,
  palette.foam,
  palette.seaglass,
  [255, 179, 193],
];
const TAU = Math.PI * 2;

function bodyPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: number,
  wobble: number,
) {
  ctx.beginPath();
  const steps = wobble > 0.001 ? 72 : 0;
  if (!steps) {
    ctx.arc(cx, cy, r, 0, TAU);
    return;
  }
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * TAU;
    const rr = r * edge(theta, t, wobble);
    const x = cx + Math.cos(theta) * rr;
    const y = cy + Math.sin(theta) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawHalo(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  strength: number,
  color: Rgb,
) {
  const outer = r * (1.5 + strength * 0.5);
  const halo = ctx.createRadialGradient(cx, cy, r * 0.95, cx, cy, outer);
  halo.addColorStop(0, rgba(color, 0.75 * strength));
  halo.addColorStop(0.3, rgba(color, 0.3 * strength));
  halo.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(cx - outer, cy - outer, outer * 2, outer * 2);
}

function drawRings(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  { t, level, params }: Frame,
) {
  if (params.rings < 0.01) return;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) {
    const p = (t * 0.55 + i / 3) % 1;
    const alpha = (1 - p) * (1 - p) * params.rings * (0.15 + level * 0.6);
    ctx.strokeStyle = rgba(params.halo, alpha);
    ctx.beginPath();
    ctx.arc(cx, cy, r * (1.04 + p * 0.62), 0, TAU);
    ctx.stroke();
  }
}

function drawOrbit(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  { t, params }: Frame,
) {
  if (params.orbit < 0.01) return;
  const head = t * 2.4;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, r * 0.035);
  for (let i = 0; i < 12; i++) {
    const a = head - i * 0.07;
    ctx.strokeStyle = rgba(params.halo, params.orbit * (1 - i / 12) * 0.9);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.2, a - 0.08, a);
    ctx.stroke();
  }
}

/** The pearl body: nacre base, drifting iridescence, depth, rim light and highlight. */
function drawBody(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  { t, level, params }: Frame,
) {
  ctx.save();
  bodyPath(ctx, cx, cy, r, t, params.wobble * params.voice * level);
  ctx.clip();

  const base = ctx.createRadialGradient(
    cx - r * 0.32,
    cy - r * 0.38,
    r * 0.02,
    cx,
    cy,
    r * 1.1,
  );
  base.addColorStop(0, "#ffffff");
  base.addColorStop(0.22, "#f3f1f8");
  base.addColorStop(0.55, "#dcdcec");
  base.addColorStop(0.85, "#9aa1c2");
  base.addColorStop(1, "#5f6889");
  ctx.fillStyle = base;
  ctx.fillRect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4);

  // Mother-of-pearl: a slowly turning band of colour, strongest off-centre.
  const spin = t * params.sheen;
  const band = ctx.createConicGradient(spin, cx + r * 0.1, cy + r * 0.12);
  [...sheenColors, sheenColors[0]].forEach((color, i, all) =>
    band.addColorStop(i / (all.length - 1), rgba(color, 0.85)),
  );
  ctx.globalCompositeOperation = "overlay";
  ctx.fillStyle = band;
  ctx.fillRect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4);
  ctx.globalCompositeOperation = "source-over";

  // Soft colour pools drifting the other way, so the sheen never repeats.
  sheenColors.forEach((color, i) => {
    const angle = -spin * 0.7 + (i * TAU) / sheenColors.length;
    const x = cx + Math.cos(angle) * r * 0.5;
    const y = cy + Math.sin(angle) * r * 0.5;
    const pool = ctx.createRadialGradient(x, y, 0, x, y, r * 0.62);
    pool.addColorStop(0, rgba(color, 0.45));
    pool.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = pool;
    ctx.fillRect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4);
  });

  // Depth towards the lower right edge, tinted by the deep water around it.
  const depth = ctx.createRadialGradient(
    cx - r * 0.2,
    cy - r * 0.25,
    r * 0.45,
    cx,
    cy,
    r * 1.08,
  );
  depth.addColorStop(0, "rgba(6, 25, 43, 0)");
  depth.addColorStop(1, `rgba(6, 25, 43, ${0.5 + params.dim * 0.3})`);
  ctx.fillStyle = depth;
  ctx.fillRect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4);

  // Rim light: the state colour reflected along the lower edge.
  const rim = ctx.createRadialGradient(
    cx + r * 0.25,
    cy + r * 0.55,
    r * 0.1,
    cx + r * 0.25,
    cy + r * 0.55,
    r * 0.9,
  );
  const rimAlpha = 0.35 + params.glow * 0.35 + level * params.voice * 0.3;
  rim.addColorStop(0, rgba(params.halo, rimAlpha));
  rim.addColorStop(1, rgba(params.halo, 0));
  ctx.fillStyle = rim;
  ctx.fillRect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4);

  if (params.dim > 0.01) {
    ctx.fillStyle = `rgba(6, 25, 43, ${params.dim * 0.55})`;
    ctx.fillRect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4);
  }

  // Specular highlight from the light above the water.
  ctx.translate(cx - r * 0.36, cy - r * 0.44);
  ctx.rotate(-0.65);
  ctx.scale(1, 0.62);
  const shine = 0.95 - params.dim * 0.5;
  const spec = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.34);
  spec.addColorStop(0, `rgba(255, 255, 255, ${shine})`);
  spec.addColorStop(0.35, `rgba(255, 255, 255, ${shine * 0.75})`);
  spec.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = spec;
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.restore();

  // A thin bright edge where the pearl meets the water.
  ctx.save();
  bodyPath(ctx, cx, cy, r * 0.985, t, params.wobble * params.voice * level);
  ctx.lineWidth = Math.max(1, r * 0.018);
  const edgeLight = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
  edgeLight.addColorStop(0, "rgba(255, 255, 255, 0.05)");
  edgeLight.addColorStop(1, rgba(params.halo, 0.55 + params.glow * 0.3));
  ctx.strokeStyle = edgeLight;
  ctx.stroke();
  ctx.restore();
}

/** Draws one frame into a canvas already scaled to CSS pixels. */
export function drawPearl(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: Frame,
) {
  const { t, level, params } = frame;
  const cx = width / 2;
  const cy = height / 2;
  const breath = Math.sin((t * TAU) / 3.2) * params.breathe;
  const swell = level * params.voice * 0.06;
  const r = (Math.min(width, height) / 2) * 0.5 * (1 + breath + swell);
  ctx.clearRect(0, 0, width, height);
  const strength = params.glow + level * params.voice * 0.55;
  drawHalo(ctx, cx, cy, r, Math.min(1, strength), params.halo);
  drawRings(ctx, cx, cy, r, frame);
  drawOrbit(ctx, cx, cy, r, frame);
  drawBody(ctx, cx, cy, r, frame);
}
