/**
 * Liquid-metal "hello" morph. Plain WebGL + 2D canvas, no framework.
 * Pipeline: text canvas -> threshold (goo) -> separable blur (edge field) -> metal shader.
 */
import { hellos, metal, motion, timing } from "../config";

const FONT = "Raleway";

// Raleway 900 is bundled by @fontsource (imported in LiquidHello.astro).
// We load only the Latin subset first (covers "hello" and most greetings)
// so the animation can start immediately. Extended subsets for accented
// characters (e.g. cześć) are fetched in the background after the loop starts.
async function loadFont() {
  await document.fonts.load(`900 100px ${FONT}`, "hello");
}
function loadExtendedFont() {
  // Loads latin-ext (ś, ć, etc.) and any other subsets needed by the full
  // hellos list. Called without await — the first several "hello" hold-times
  // give ample time for this to finish before an accented word is picked.
  document.fonts.load(`900 100px ${FONT}`, hellos.join("")).catch(() => {});
}

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Pass 1: threshold the blurred text into a soft-edged shape (the "goo")
const MASK_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform float uSoft;
varying vec2 vUv;
void main() {
  float a = texture2D(uTex, vUv).a;
  float m = smoothstep(0.55 - uSoft, 0.55 + uSoft, a);
  gl_FragColor = vec4(m);
}`;

// Pass 2+3: separable gaussian blur -> smooth "distance from edge" field
const BLUR_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  float sum = 0.0, wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i) / 4.0;
    float w = exp(-0.5 * x * x);
    sum += texture2D(uTex, vUv + uDir * x).r * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum);
}`;

// Pass 4: liquid metal shading (transparent outside the letters)
const METAL_FRAG = `
precision highp float;
uniform sampler2D uMask;
uniform sampler2D uField;
uniform vec2 uRes;
uniform vec2 uFieldTexel;
uniform float uTime, uEnergy, uShape;
uniform vec3 uTint;
uniform float uRep, uSoftness, uShiftR, uShiftB, uDist, uContour, uAngle, uScale;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
float stripe(float x) {
  float v = fract(x);
  float s = max(uSoftness, 0.01);
  float g = 1.0 - smoothstep(0.1, 0.9, v);
  return mix(g, 1.0, smoothstep(1.0 - s, 1.0, v));
}

void main() {
  // No early return here: sampling a texture after a per-pixel branch is
  // rejected by some Windows (ANGLE/D3D) shader compilers. m masks it anyway.
  float m = texture2D(uMask, vUv).r;

  float d = texture2D(uField, vUv).r;
  vec2 e = uFieldTexel * 2.0;
  vec2 grad = vec2(
    texture2D(uField, vUv + vec2(e.x, 0.0)).r - texture2D(uField, vUv - vec2(e.x, 0.0)).r,
    texture2D(uField, vUv + vec2(0.0, e.y)).r - texture2D(uField, vUv - vec2(0.0, e.y)).r
  ) * 8.0;
  float edge = 1.0 - smoothstep(0.45, 0.95, d);

  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (uShape * uScale);
  float ang = radians(uAngle);
  vec2 dir = vec2(cos(ang), sin(ang));
  float n = fbm(p * 1.5 + vec2(uTime * 0.6, -uTime * 0.4));

  float x = dot(p, dir) * uRep * 0.5
          + uContour * (edge * edge * 2.2 + dot(grad, dir) * 1.5) * (1.0 + uEnergy)
          + uDist * (n - 0.5) * (0.35 + 0.9 * uEnergy)
          - uTime;

  float sh = 0.06 * (0.4 + edge);
  vec3 col = vec3(stripe(x + uShiftR * sh), stripe(x), stripe(x - uShiftB * sh));
  vec3 burned = 1.0 - min(vec3(1.0), (1.0 - col) / max(uTint, vec3(0.001)));
  col = mix(col, burned, 0.6);
  col *= mix(1.0, 0.85, edge * 0.5);
  gl_FragColor = vec4(col * m, m); // premultiplied
}`;

const easeInOut = (x: number) => 0.5 - Math.cos(x * Math.PI) / 2;

const pickNext = (current: string) => {
  if (current === "") return hellos[0];
  let next = current;
  while (next === current) next = hellos[Math.floor(Math.random() * hellos.length)];
  return next;
};

type Prog = WebGLProgram & { u: (name: string) => WebGLUniformLocation | null };
type Fbo = { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number };


const log = (...a: unknown[]) => console.warn("[liquid-hello]", ...a);

type Frame = { W: number; H: number; fontPx: number; shaderTime: number; energy: number; settled: boolean };
type Renderer = {
  resize(W: number, H: number): void;
  render(frame: Frame): void;
  dispose(): void;
  onLost?: (cb: () => void) => void;
};

/* =========================================================
   WebGL renderer: mask -> blur -> metal. Throws if anything
   about the GL setup fails, so the caller can fall back.
   ========================================================= */
function createGLRenderer(canvas: HTMLCanvasElement, textCanvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: true, alpha: true });
  if (!gl) throw new Error("WebGL is unavailable (disabled, blocklisted driver, or hardware acceleration off)");

  const compile = (type: number, src: string, name: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost())
      throw new Error(`${name} shader failed to compile:\n${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const program = (frag: string, name: string): Prog => {
    const p = gl.createProgram()! as Prog;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT, "vertex"));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag, name));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost())
      throw new Error(`${name} program failed to link:\n${gl.getProgramInfoLog(p)}`);
    const cache: Record<string, WebGLUniformLocation | null> = {};
    p.u = (n) => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(p, n)));
    return p;
  };
  const makeTex = (w?: number, h?: number) => {
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w && h) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  };
  const makeFbo = (w: number, h: number): Fbo => {
    const tex = makeTex(w, h);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost())
      throw new Error(`framebuffer ${w}x${h} incomplete (0x${status.toString(16)})`);
    return { fb, tex, w, h };
  };
  const freeFbo = (f?: Fbo) => {
    if (!f) return;
    gl.deleteFramebuffer(f.fb);
    gl.deleteTexture(f.tex);
  };

  const progMask = program(MASK_FRAG, "mask");
  const progBlur = program(BLUR_FRAG, "blur");
  const progMetal = program(METAL_FRAG, "metal");

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const textTex = makeTex();
  let fboMask: Fbo | undefined, fboA: Fbo | undefined, fboB: Fbo | undefined;
  let verified = false;
  let lostCb: (() => void) | undefined;

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    log("WebGL context lost, switching to fallback");
    lostCb?.();
  });

  const pass = (prog: Prog, target: Fbo | null, w: number, h: number, setup: (p: Prog) => void) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    setup(prog);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const bindTex = (prog: Prog, name: string, tex: WebGLTexture, unit: number) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.u(name), unit);
  };

  return {
    onLost: (cb) => (lostCb = cb),
    resize(W, H) {
      canvas.width = W;
      canvas.height = H;
      freeFbo(fboMask); freeFbo(fboA); freeFbo(fboB);
      const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1);
      fboMask = makeFbo(W, H);
      fboA = makeFbo(hw, hh);
      fboB = makeFbo(hw, hh);
    },
    render({ W, H, fontPx, shaderTime, energy, settled }) {
      if (!fboMask || !fboA || !fboB || gl.isContextLost()) return;
      gl.bindTexture(gl.TEXTURE_2D, textTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);

      pass(progMask, fboMask, W, H, (p) => {
        bindTex(p, "uTex", textTex, 0);
        gl.uniform1f(p.u("uSoft"), metal.edgeSoftness);
      });

      // One-off sanity check once a word is fully shown: did the text actually
      // reach the GPU? (Privacy settings can blank canvas -> WebGL uploads.)
      if (!verified && settled) {
        verified = true;
        const row = new Uint8Array(W * 4);
        gl.readPixels(0, H >> 1, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
        let max = 0;
        for (let i = 0; i < row.length; i += 4) max = Math.max(max, row[i]);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) throw new Error(`WebGL error 0x${err.toString(16)} during render`);
        if (max === 0) throw new Error("text never reached the GPU (blank canvas upload - fingerprinting protection?)");
      }

      const sigma = (fontPx * 0.07) / 2;
      pass(progBlur, fboA, fboA.w, fboA.h, (p) => {
        bindTex(p, "uTex", fboMask!.tex, 0);
        gl.uniform2f(p.u("uDir"), sigma / fboA!.w, 0);
      });
      pass(progBlur, fboB, fboB.w, fboB.h, (p) => {
        bindTex(p, "uTex", fboA!.tex, 0);
        gl.uniform2f(p.u("uDir"), 0, sigma / fboB!.h);
      });

      pass(progMetal, null, W, H, (p) => {
        bindTex(p, "uMask", fboMask!.tex, 0);
        bindTex(p, "uField", fboB!.tex, 1);
        gl.uniform2f(p.u("uRes"), W, H);
        gl.uniform2f(p.u("uFieldTexel"), 1 / fboB!.w, 1 / fboB!.h);
        gl.uniform1f(p.u("uTime"), shaderTime);
        gl.uniform1f(p.u("uEnergy"), energy);
        gl.uniform1f(p.u("uShape"), fontPx * 1.2);
        gl.uniform3fv(p.u("uTint"), metal.colorTint);
        gl.uniform1f(p.u("uRep"), metal.repetition);
        gl.uniform1f(p.u("uSoftness"), metal.softness);
        gl.uniform1f(p.u("uShiftR"), metal.shiftRed);
        gl.uniform1f(p.u("uShiftB"), metal.shiftBlue);
        gl.uniform1f(p.u("uDist"), metal.distortion);
        gl.uniform1f(p.u("uContour"), metal.contour);
        gl.uniform1f(p.u("uAngle"), metal.angle);
        gl.uniform1f(p.u("uScale"), metal.scale);
      });
    },
    dispose() {
      freeFbo(fboMask); freeFbo(fboA); freeFbo(fboB);
    },
  };
}

/* =========================================================
   2D fallback: same blurred cross-fade, filled with a moving
   silver gradient. No goo, but never an empty page.
   ========================================================= */
function createFallbackRenderer(canvas: HTMLCanvasElement, textCanvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext("2d")!;
  return {
    resize(W, H) {
      canvas.width = W;
      canvas.height = H;
    },
    render({ W, H, fontPx, shaderTime }) {
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(textCanvas, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      const ang = (metal.angle * Math.PI) / 180;
      const len = fontPx * 3;
      const off = ((shaderTime * fontPx) % len) - len / 2;
      const cx = W / 2 + Math.cos(ang) * off, cy = H / 2 - Math.sin(ang) * off;
      const g = ctx.createLinearGradient(
        cx - Math.cos(ang) * len, cy + Math.sin(ang) * len,
        cx + Math.cos(ang) * len, cy - Math.sin(ang) * len
      );
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.25, "#8a8a8a");
      g.addColorStop(0.5, "#f2f2f2");
      g.addColorStop(0.75, "#6e6e6e");
      g.addColorStop(1, "#ffffff");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    },
    dispose() {},
  };
}

export function startLiquid(initialCanvas: HTMLCanvasElement): () => void {
  let canvas = initialCanvas;
  const textCanvas = document.createElement("canvas");
  const tctx = textCanvas.getContext("2d")!;
  if (!("filter" in tctx)) log("canvas 2D filter unsupported - morph will be less gooey");

  let W = 1, H = 1, dpr = 1, fontPx = 100;
  let renderer: Renderer;

  const useFallback = (reason: unknown) => {
    log("falling back to 2D text:", reason instanceof Error ? reason.message : reason);
    renderer?.dispose();
    // A canvas that's had a WebGL context can't give a 2D one, so swap it out.
    const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(fresh);
    canvas = fresh;
    renderer = createFallbackRenderer(canvas, textCanvas);
    renderer.resize(W, H);
  };

  const measure = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(canvas.clientWidth * dpr));
    H = Math.max(1, Math.round(canvas.clientHeight * dpr));
    textCanvas.width = W;
    textCanvas.height = H;
    fontPx = Math.min(canvas.clientWidth / 3, 150) * dpr;
  };
  const resize = () => {
    measure();
    try {
      renderer.resize(W, H);
    } catch (e) {
      useFallback(e);
    }
  };

  measure();
  try {
    renderer = createGLRenderer(canvas, textCanvas);
    renderer.onLost?.(() => useFallback("context lost"));
    renderer.resize(W, H);
  } catch (e) {
    useFallback(e);
  }
  window.addEventListener("resize", resize);

  /* -------- morph state -------- */
  let morphing = false;
  let timer = timing.introDelay;
  let f = 1;
  let wordOut = "";
  let wordIn = "";
  let energy = 0;
  let shaderTime = 0;

  const drawWord = (str: string, presence: number, role: "in" | "out") => {
    if (!str) return;
    const op = Math.pow(presence, 0.4);
    if (op < 0.002) return;
    const k = fontPx / 107;
    const blurPx = presence <= 0 ? 100 : Math.min(8 / presence - 8, 100);
    const away = 1 - presence;
    const s = 1 + ((role === "out" ? motion.exitScale : motion.enterScale) - 1) * away;

    tctx.save();
    tctx.translate(W / 2, H / 2);
    tctx.scale(s, s);
    tctx.filter = blurPx * k > 0.01 ? `blur(${blurPx * k}px)` : "none";
    tctx.globalAlpha = op;
    tctx.fillText(str, 0, 0);
    tctx.restore();
  };

  const drawText = () => {
    tctx.clearRect(0, 0, W, H);
    tctx.font = `900 ${fontPx}px ${FONT}`;
    tctx.textAlign = "center";
    tctx.textBaseline = "middle";
    tctx.fillStyle = "#fff";
    drawWord(wordOut, 1 - f, "out");
    drawWord(wordIn, f, "in");
  };

  let raf = 0;
  let last = performance.now();
  const animate = () => {
    raf = requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    if (!morphing) {
      timer -= dt;
      f = 1;
      if (timer <= 0) {
        morphing = true;
        timer = 0;
        wordOut = wordIn;
        wordIn = pickNext(wordIn);
        f = 0;
      }
    } else {
      timer += dt;
      const frac = Math.min(timer / timing.morph, 1);
      f = easeInOut(frac);
      if (frac >= 1) {
        morphing = false;
        timer = timing.stayMin + Math.random() * (timing.stayMax - timing.stayMin);
      }
    }

    let target = 0;
    if (morphing) target = 1;
    else if (timer < timing.lead) target = easeInOut(1 - timer / timing.lead);
    energy += (target - energy) * Math.min(1, dt * 3);
    shaderTime += dt * metal.speed * 1.5 * (1 + timing.transitionBoost * energy);

    drawText();
    const frame = { W, H, fontPx, shaderTime, energy, settled: !morphing && wordIn !== "" };
    try {
      renderer.render(frame);
    } catch (e) {
      useFallback(e);
      renderer.render(frame);
    }
  };

  let cancelled = false;
  loadFont()
    .catch((e) => log("font failed to load, using fallback font:", e))
    .finally(() => {
      if (cancelled) return;
      last = performance.now();
      animate();
      // Kick off extended subset loading in the background now that the
      // animation loop is running and the critical path is unblocked.
      loadExtendedFont();
    });

  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    renderer.dispose();
  };
}

