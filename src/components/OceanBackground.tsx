import { memo, useEffect, useRef, useState } from "react";
import { captureLevelStore } from "../captureLevel";
import abyssStill from "../assets/ocean-abyss.webp";
import shallowsStill from "../assets/ocean-shallows.webp";

const vertex = `attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

// Analytic waves and refracted light. No textures, image downloads or frame buffers.
const fragment = `precision highp float;
uniform vec2 resolution;
uniform vec2 pointer;
uniform float time;
uniform float voice;
uniform vec3 touch;
uniform float shallow;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1.,0.)), f.x), mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), f.x), f.y);
}
float water(vec2 p, float t) {
  p += .65 * vec2(sin(p.y*1.12+t*.18), cos(p.x*1.23-t*.14));
  float a = sin(p.x + sin(p.y*.93+t*.19));
  float b = cos(p.y*1.13 + sin(p.x*.87-t*.17));
  return pow(max(0., 1.-abs(a+b)*.56), 15.);
}
void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  float aspect = resolution.x/resolution.y;
  vec2 p = vec2((uv.x-.5)*aspect, uv.y);
  p += pointer * vec2(.025,.013);
  float t = time;
  // Abyss (dark) and Shallows (light) share one scene with different water.
  vec3 deep = mix(vec3(.008,.033,.076), vec3(.30,.62,.76), shallow);
  vec3 blue = mix(vec3(.009,.17,.29), vec3(.55,.82,.91), shallow);
  vec3 teal = mix(vec3(.017,.36,.46), vec3(.82,.96,.99), shallow);
  float depth = smoothstep(-.12,1.15,uv.y);
  vec3 col = mix(deep, blue, depth);
  col = mix(col, teal, pow(depth,3.)*.6);

  // Broad underwater currents move on different time scales.
  float swell = sin(p.x*2.2 + sin(p.y*3.8+t*.13) + t*.09);
  float current = noise(vec2(p.x*2.4+t*.024,p.y*3.-t*.035));
  col += vec3(.0,.028,.045) * (swell*.5+.5) * current;

  // Perspective compresses the waves toward the surface at the top.
  float perspective = 1.0 / max(.18, 1.30-p.y);
  vec2 sea = vec2(p.x*3.3*perspective, perspective*3.4);
  sea += vec2(t*.035,-t*.045);
  float c1 = water(sea*2.1,t);
  float c2 = water(sea*3.5+vec2(4.2,1.7),t*.8);
  float surface = smoothstep(.38,1.,p.y);
  float caustic = c1*.65+c2*.35;
  col += mix(vec3(.055,.39,.49), vec3(.30,.26,.20), shallow) * caustic * mix(surface, .35+.65*surface, shallow) * (.45+.55*depth);
  col += mix(vec3(.10,.35,.39), vec3(.20,.18,.14), shallow) * pow(c1*c2,2.) * surface;

  // A luminous moving aperture casts long, soft shafts through the water.
  vec2 light = vec2(.29*aspect + sin(t*.055)*.025,1.22);
  float slope = (p.x-light.x)/(light.y-p.y+.15);
  float beams = pow(max(0.,sin(slope*19.+t*.12+sin(slope*5.-t*.07))),12.);
  beams += .5*pow(max(0.,sin(slope*31.-t*.09)),20.);
  float cone = exp(-pow(slope*.55,2.));
  float shaft = beams*cone*pow(depth,1.8)*.19;
  col += mix(vec3(.10,.50,.60), vec3(.20,.22,.18), shallow)*shaft;
  float glow = exp(-length((p-light)*vec2(.8,1.4))*3.3);
  col += mix(vec3(.09,.43,.51), vec3(.16,.14,.10), shallow)*glow*.7;

  // Soft submerged contours, gently displaced by voice energy.
  vec2 ripple = vec2(p.x, (p.y-.42)*1.6);
  float radius = length(ripple);
  float ring = pow(max(0.,sin(radius*32.-t*.8)),18.);
  col += vec3(.02,.23,.29)*ring*exp(-radius*4.)*voice*.22;

  // A touch leaves a widening ring of light under the surface.
  float age = time-touch.z;
  float distanceToTouch = length((uv-touch.xy)*vec2(aspect,1.));
  float front = distanceToTouch-age*.13;
  float wake = exp(-front*front*1600.)*exp(-age*1.25)*step(0.,age);
  col += vec3(.02,.22,.28)*wake;

  // A handful of slow drifting motes, generated from a stable spatial grid.
  vec2 dust = vec2(p.x*17.+t*.025,p.y*17.-t*.045);
  vec2 cell = floor(dust), f = fract(dust);
  float seed = hash(cell);
  vec2 center = vec2(.2+.6*seed,.2+.6*hash(cell+3.));
  float mote = exp(-length(f-center)*100.)*step(.955,seed);
  col += vec3(.26,.58,.65)*mote*(.3+.7*depth);

  float vignette = 1.-mix(.24,.12,shallow)*pow(length((uv-.5)*vec2(1.15,.8)),1.4);
  col *= vignette;
  col = min(col, vec3(1.));
  // Dither prevents visible bands in the deep navy gradients.
  col += (hash(gl_FragCoord.xy)-.5)/255.;
  gl_FragColor = vec4(col,1.);
}`;

export const OceanBackground = memo(function OceanBackground({
  recording,
  theme,
  covered,
}: {
  recording: boolean;
  theme: "light" | "dark";
  /** A workspace sheet hides most of the water; animate more slowly. */
  covered: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const active = useRef(recording);
  const shallow = useRef(theme === "light" ? 1 : 0);
  const slow = useRef(covered);
  const repaint = useRef<() => void>(() => {});
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    active.current = recording;
  }, [recording]);
  useEffect(() => {
    slow.current = covered;
  }, [covered]);
  useEffect(() => {
    shallow.current = theme === "light" ? 1 : 0;
    repaint.current();
  }, [theme]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    if (!gl) return;
    const shaders: WebGLShader[] = [];
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Ocean shader unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Ocean shader unsupported");
      return shader;
    };
    const program = gl.createProgram();
    if (!program) return;
    let buffer: WebGLBuffer | null = null;
    try {
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("Ocean program unsupported");
      gl.useProgram(program);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      const position = gl.getAttribLocation(program, "position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    } catch {
      shaders.forEach((shader) => gl.deleteShader(shader));
      gl.deleteProgram(program);
      if (buffer) gl.deleteBuffer(buffer);
      return;
    }
    const uniforms = {
      resolution: gl.getUniformLocation(program, "resolution"),
      pointer: gl.getUniformLocation(program, "pointer"),
      time: gl.getUniformLocation(program, "time"),
      voice: gl.getUniformLocation(program, "voice"),
      touch: gl.getUniformLocation(program, "touch"),
      shallow: gl.getUniformLocation(program, "shallow"),
    };
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : "";
    const software = /swiftshader|llvmpipe|software/i.test(renderer);
    const pixelBudget = software ? 200_000 : 900_000;
    const frameInterval = 1000 / (software ? 20 : 30);
    let touchX = 0.5,
      touchY = 0.5,
      touchTime = -100;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0,
      last = 0,
      elapsed = 14,
      level = 0,
      volume = 0;
    let x = 0,
      y = 0,
      targetX = 0,
      targetY = 0;
    let lost = false;
    const paint = () => {
      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform2f(uniforms.pointer, x, y);
      gl.uniform1f(uniforms.time, elapsed);
      gl.uniform1f(uniforms.voice, volume);
      gl.uniform3f(uniforms.touch, touchX, touchY, touchTime);
      gl.uniform1f(uniforms.shallow, shallow.current);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (!canvas.dataset.rendered) canvas.dataset.rendered = "true";
    };
    const animate = (now: number) => {
      frame = 0;
      if (lost || document.hidden || motion.matches) return;
      if (!last || now - last >= (slow.current ? 1000 / 12 : frameInterval)) {
        const delta = last ? Math.min((now - last) / 1000, 0.1) : 0;
        elapsed += delta;
        last = now;
        x += (targetX - x) * 0.035;
        y += (targetY - y) * 0.035;
        volume += ((active.current ? level : 0) - volume) * 0.09;
        paint();
      }
      frame = requestAnimationFrame(animate);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      if (lost || document.hidden) return;
      if (motion.matches) {
        x = 0;
        y = 0;
        volume = 0;
        paint();
      } else frame = requestAnimationFrame(animate);
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      // At most 900k pixels, independent of high-DPI monitor size.
      const ratio = Math.min(
        devicePixelRatio || 1,
        1.25,
        Math.sqrt(pixelBudget / Math.max(1, rect.width * rect.height)),
      );
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (!lost && !document.hidden) paint();
    };
    const move = (event: PointerEvent) => {
      targetX = (event.clientX / innerWidth - 0.5) * 2;
      targetY = (event.clientY / innerHeight - 0.5) * 2;
    };
    const touch = (event: PointerEvent) => {
      if (
        motion.matches ||
        (event.target as Element).closest(".workspace-sheet, dialog")
      )
        return;
      touchX = event.clientX / innerWidth;
      touchY = 1 - event.clientY / innerHeight;
      touchTime = elapsed;
    };
    const leave = () => {
      targetX = 0;
      targetY = 0;
    };
    const onLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      delete canvas.dataset.rendered;
      cancelAnimationFrame(frame);
    };
    const onRestored = () => setGeneration((value) => value + 1);
    const removeLevel = captureLevelStore.subscribe(() => {
      level = (captureLevelStore.getSnapshot().db + 60) / 60;
    });
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener("visibilitychange", schedule);
    motion.addEventListener("change", schedule);
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", touch, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    repaint.current = () => {
      if (!lost && !document.hidden) paint();
    };
    resize();
    schedule();
    return () => {
      repaint.current = () => {};
      cancelAnimationFrame(frame);
      observer.disconnect();
      removeLevel();
      document.removeEventListener("visibilitychange", schedule);
      motion.removeEventListener("change", schedule);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", touch);
      document.documentElement.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      gl.deleteBuffer(buffer);
      shaders.forEach((shader) => gl.deleteShader(shader));
      gl.deleteProgram(program);
    };
  }, [generation]);
  return (
    <div className="ocean-background" aria-hidden="true">
      {/* A pre-rendered sea for systems without WebGL (Wayland disables the GPU). */}
      <div
        className="ocean-still"
        style={{
          backgroundImage: `url(${theme === "light" ? shallowsStill : abyssStill})`,
        }}
      />
      <canvas ref={canvasRef} className="ocean-canvas" />
      <div className="ocean-atmosphere" />
    </div>
  );
});
