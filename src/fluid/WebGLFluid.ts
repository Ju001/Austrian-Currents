import type { MercatorXY, ColorWeight } from "./types";
import {
  VERT,
  ADVECT,
  DIVERGENCE,
  JACOBI,
  GRADIENT_SUBTRACT,
  VORTICITY,
  VORT_CONFINE,
  FORCE,
  BOUNDARY_VELOCITY,
  BOUNDARY_DYE,
  SPLAT,
  BLUR,
  BLOOM_PREFILTER,
  DISPLAY,
} from "./shaders";

// ── WebGL helpers ─────────────────────────────────────────────────────────────

function compile(
  gl: WebGLRenderingContext,
  type: number,
  src: string,
): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error(`Shader compile error:\n${gl.getShaderInfoLog(sh)}`);
  return sh;
}

function link(
  gl: WebGLRenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vertSrc));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`Program link error:\n${gl.getProgramInfoLog(prog)}`);
  return prog;
}

interface FBO {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

interface DoubleFBO {
  read: FBO;
  write: FBO;
  swap(): void;
}

/** A short-lived dye source that eases its colour in and out over its lifetime. */
interface Emitter {
  u: number;
  v: number;
  color: [number, number, number];
  dx: number; // one-time velocity impulse, fired at birth
  dy: number;
  radius: number;
  bornMs: number;
  fired: boolean; // whether the velocity impulse has been injected yet
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SIM_W = 512; // higher res → smoother fluid & national border
const SIM_H = 512;
const TEXEL_SIZE: [number, number] = [1 / SIM_W, 1 / SIM_H];
const ALPHA = -(TEXEL_SIZE[0] * TEXEL_SIZE[0]); // -h² for Jacobi
const JACOBI_ITERS = 20;
const VELOCITY_DISS = 0.999; // mild — the background gyre keeps replenishing it
const DYE_DISS = 0.9999; // per-frame multiplier — slow fade so dye covers the basin evenly
const VORT_STRENGTH = 6.0; // lower → colours mix more slowly, stay distinct longer
const DISPLAY_SATURATION = 1.6; // >1 deepens hue to fight wash-out
const DISPLAY_BRIGHTNESS = 1.25; // >1 lifts faded dye back toward vivid
const SPLAT_RADIUS = 0.075; // larger blobs so each refresh is visible and spreads
const SPLAT_FORCE = 0.3; // directional velocity impulse per splat (UV/s)
const DYE_STRENGTH = 1.0; // paint toward the full pure fuel colour
const PAINT_RATE = 0.6; // per-60fps-frame dye paint convergence (dt-scaled at runtime)
const SPLAT_FADE_MS = 1500; // emitter lifetime: dye eases in then out (no pop)
const REF_FPS = 60; // reference framerate the decay/paint constants are tuned at
const BLUR_SPREAD = 1.5; // texel spacing of the soft-border blur taps
const BLOOM_THRESHOLD = 0.45; // brightness above which dye contributes to bloom
const BLOOM_SPREAD = 4.0; // texel spacing of the wide bloom blur taps
const BLOOM_STRENGTH = 0.8; // glow intensity added at display
const BG_FORCE = 0.001; // permanent rotational body force (tangential UV/s)
const BG_CENTER: [number, number] = [0.5, 0.5]; // gyre centre in sim UV
const BORDER_BAND = 0.05; // free-slip band width just inside the border (SDF units)

// ── Main fluid renderer ───────────────────────────────────────────────────────

export class WebGLFluid {
  private readonly gl: WebGLRenderingContext;

  // Programs
  private readonly pAdvect: WebGLProgram;
  private readonly pDiv: WebGLProgram;
  private readonly pJacobi: WebGLProgram;
  private readonly pGradSub: WebGLProgram;
  private readonly pVort: WebGLProgram;
  private readonly pVortConf: WebGLProgram;
  private readonly pForce: WebGLProgram;
  private readonly pBoundaryVel: WebGLProgram;
  private readonly pBoundaryDye: WebGLProgram;
  private readonly pSplat: WebGLProgram;
  private readonly pBlur: WebGLProgram;
  private readonly pBloomPre: WebGLProgram;
  private readonly pDisplay: WebGLProgram;

  // FBOs
  private readonly velocity: DoubleFBO;
  private readonly pressure: DoubleFBO;
  private readonly divergence: FBO;
  private readonly dye: DoubleFBO;
  private readonly vorticity: FBO;
  // Post-processing scratch (blur ping-pong + final bloom), all sim-resolution.
  private readonly ppA: FBO;
  private readonly ppB: FBO;
  private readonly bloomTex: FBO;

  // Geometry
  private readonly quad: WebGLBuffer;

  // SDF
  private sdfTex: WebGLTexture;
  private sdfOrigin: MercatorXY = [0, 0];
  private sdfScale: MercatorXY = [1, 1];

  // Interior injection points (sim UV) — populated from SDF
  private interiorPoints: Array<[number, number]> = [];

  // Energy-mix colours, normalised so weights sum to 1
  private colors: ColorWeight[] = [];

  // Viewport Mercator corners
  private tl: MercatorXY = [0, 0];
  private tr: MercatorXY = [1, 0];
  private bl: MercatorXY = [0, 1];
  private br: MercatorXY = [1, 1];

  // Animation state
  private lastTimeMs = 0;
  private nextSplatMs = 0;
  private emitters: Emitter[] = [];
  private initialized = false;
  private pendingDyeClear = false; // set by setColors() to flush stale dye

  // Float texture format negotiated at construction time
  private readonly floatType: number;
  private readonly floatInternal: number;

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl;

    // Detect float-texture support for both WebGL 1 and WebGL 2.
    // MapLibre GL v5 uses a WebGL 2 context, where OES_texture_float
    // does not exist — float FBOs are enabled via EXT_color_buffer_float
    // and use the sized internal format RGBA32F.
    const isWebGL2 =
      typeof WebGL2RenderingContext !== "undefined" &&
      gl instanceof WebGL2RenderingContext;

    if (isWebGL2) {
      const gl2 = gl as unknown as WebGL2RenderingContext;
      // EXT_color_buffer_float enables both RGBA32F and RGBA16F as render targets.
      // We always use RGBA16F because it supports gl.LINEAR natively in WebGL 2;
      // RGBA32F requires OES_texture_float_linear for linear filtering — not universal.
      if (!gl.getExtension("EXT_color_buffer_float")) {
        throw new Error(
          "Float framebuffer not supported (EXT_color_buffer_float missing)",
        );
      }
      this.floatType = gl2.HALF_FLOAT;
      this.floatInternal = gl2.RGBA16F;
    } else {
      // WebGL 1
      if (gl.getExtension("OES_texture_float")) {
        gl.getExtension("WEBGL_color_buffer_float");
        this.floatType = gl.FLOAT;
        this.floatInternal = gl.RGBA;
      } else {
        const half = gl.getExtension("OES_texture_half_float");
        if (!half) throw new Error("Float textures not supported");
        gl.getExtension("EXT_color_buffer_half_float");
        this.floatType = (half as { HALF_FLOAT_OES: number }).HALF_FLOAT_OES;
        this.floatInternal = gl.RGBA;
      }
    }

    this.pAdvect = link(gl, VERT, ADVECT);
    this.pDiv = link(gl, VERT, DIVERGENCE);
    this.pJacobi = link(gl, VERT, JACOBI);
    this.pGradSub = link(gl, VERT, GRADIENT_SUBTRACT);
    this.pVort = link(gl, VERT, VORTICITY);
    this.pVortConf = link(gl, VERT, VORT_CONFINE);
    this.pForce = link(gl, VERT, FORCE);
    this.pBoundaryVel = link(gl, VERT, BOUNDARY_VELOCITY);
    this.pBoundaryDye = link(gl, VERT, BOUNDARY_DYE);
    this.pSplat = link(gl, VERT, SPLAT);
    this.pBlur = link(gl, VERT, BLUR);
    this.pBloomPre = link(gl, VERT, BLOOM_PREFILTER);
    this.pDisplay = link(gl, VERT, DISPLAY);

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.velocity = this.makeDouble();
    this.pressure = this.makeDouble();
    this.divergence = this.makeSingle();
    this.dye = this.makeDouble();
    this.vorticity = this.makeSingle();
    this.ppA = this.makeFBO(this.makeTex(gl.LINEAR));
    this.ppB = this.makeFBO(this.makeTex(gl.LINEAR));
    this.bloomTex = this.makeFBO(this.makeTex(gl.LINEAR));

    // RGBA16F textures are NOT guaranteed to be zero-initialised by the driver.
    // Garbage values in the dye FBO would appear as immediate white on first render.
    gl.clearColor(0, 0, 0, 0);
    [
      this.velocity.read,
      this.velocity.write,
      this.pressure.read,
      this.pressure.write,
      this.dye.read,
      this.dye.write,
      this.divergence,
      this.vorticity,
      this.ppA,
      this.ppB,
      this.bloomTex,
    ].forEach((fbo) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Fallback SDF: single white texel (d=1 = interior everywhere) until real SDF loads.
    // Use RGBA/UNSIGNED_BYTE — LUMINANCE is deprecated in WebGL 2 and may return
    // unexpected values, which would corrupt the boundary mask before the SDF arrives.
    this.sdfTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setColors(weights: ColorWeight[]): void {
    const total = weights.reduce((s, w) => s + w.weight, 0);
    if (total <= 0) {
      // Zero generation: stop emitting entirely so the existing dye decays away.
      this.colors = [];
      return;
    }
    this.colors = weights.map((w) => ({
      color: w.color,
      weight: w.weight / total,
    }));
    // No dye clear: a slider change just re-weights the palette. New splats
    // paint in the updated mix while the decay fades the old colours out over a
    // few seconds, so the basin recolours smoothly instead of being reset.
  }

  setViewport(
    tl: MercatorXY,
    tr: MercatorXY,
    bl: MercatorXY,
    br: MercatorXY,
  ): void {
    this.tl = tl;
    this.tr = tr;
    this.bl = bl;
    this.br = br;
  }

  setSDF(
    data: Uint8Array,
    width: number,
    height: number,
    origin: MercatorXY,
    scale: MercatorXY,
  ): void {
    const { gl } = this;
    gl.deleteTexture(this.sdfTex);

    this.sdfTex = gl.createTexture()!;
    this.sdfOrigin = origin;
    this.sdfScale = scale;

    // Upload SDF as RGBA — the .r channel carries the distance value.
    // LUMINANCE is deprecated in WebGL 2; RGBA is universally supported.
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i++) {
      rgba[i * 4] = data[i]; // R = SDF value
      rgba[i * 4 + 1] = data[i];
      rgba[i * 4 + 2] = data[i];
      rgba[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Collect interior injection points (SDF value well above 0)
    this.interiorPoints = [];
    const threshold = 35;
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        if (data[j * width + i] > threshold) {
          this.interiorPoints.push([(i + 0.5) / width, (j + 0.5) / height]);
        }
      }
    }
  }

  render(timeMs: number): void {
    const { gl } = this;
    if (this.lastTimeMs === 0) this.lastTimeMs = timeMs;
    const dt = Math.min((timeMs - this.lastTimeMs) / 1000, 0.033);
    this.lastTimeMs = timeMs;

    // Save MapLibre GL state we'll touch
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const prevFBO = gl.getParameter(
      gl.FRAMEBUFFER_BINDING,
    ) as WebGLFramebuffer | null;
    const prevBuf = gl.getParameter(
      gl.ARRAY_BUFFER_BINDING,
    ) as WebGLBuffer | null;
    const prevVP = gl.getParameter(gl.VIEWPORT) as Int32Array;

    // MapLibre calls us with blending enabled (premultiplied alpha). The sim
    // passes must overwrite their FBOs, not blend into them — with blending on,
    // each advect pass ADDS the previous dye back in, so dissipation never wins
    // and the basin saturates to a solid colour that never decays.
    const prevBlend = gl.isEnabled(gl.BLEND);
    gl.disable(gl.BLEND);

    gl.viewport(0, 0, SIM_W, SIM_H);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);

    // ── Slider-triggered dye clear ─────────────────────────────────────────
    if (this.pendingDyeClear) {
      gl.clearColor(0, 0, 0, 0);
      [this.dye.read, this.dye.write].forEach((fbo) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
      });
      this.pendingDyeClear = false;
    }

    // ── One-time initialisation ────────────────────────────────────────────
    if (!this.initialized) {
      this.initialized = true;
      // Opening emitters with staggered births so the basin fills in gently
      // rather than popping up all at once.
      for (let i = 0; i < 6; i++) this.spawnEmitter(timeMs + i * 150);
      this.nextSplatMs = timeMs + 6 * 150;
    }

    // ── Autonomous emitters (coupled jet + eased-in dye, same point) ───────
    if (timeMs >= this.nextSplatMs) {
      this.spawnEmitter(timeMs);
      // Faster cadence replenishes fresh colour to keep pace with the decay.
      this.nextSplatMs = timeMs + 200 + Math.random() * 300;
    }

    // Paint each active emitter's dye for this frame (and fire its jet at birth).
    this.updateEmitters(timeMs, dt);

    // ── Simulation step ────────────────────────────────────────────────────
    this.computeVorticity();
    this.applyVortConfinement(dt);
    this.applyBackgroundForce(dt); // permanent gyre — never lets motion halt
    this.applyVelocityBoundary();
    this.advectVelocity(dt);
    this.applyVelocityBoundary();
    this.computeDivergence();
    this.clearPressure();
    this.solvePressure();
    this.subtractGradient();
    this.applyVelocityBoundary();
    this.advectDye(dt);
    this.applyDyeBoundary();

    // ── Post-process (blur + bloom) while still bound to the sim FBOs ───────
    this.postProcess();

    // ── Display ────────────────────────────────────────────────────────────
    // Restore blending for the final composite into MapLibre's framebuffer —
    // the display shader outputs premultiplied alpha and relies on it.
    if (prevBlend) gl.enable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
    gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
    this.drawDisplay(gl.drawingBufferWidth, gl.drawingBufferHeight);

    // Restore
    gl.bindBuffer(gl.ARRAY_BUFFER, prevBuf);
    gl.useProgram(prevProg);
  }

  destroy(): void {
    const { gl } = this;
    [
      this.pAdvect,
      this.pDiv,
      this.pJacobi,
      this.pGradSub,
      this.pVort,
      this.pVortConf,
      this.pForce,
      this.pBoundaryVel,
      this.pBoundaryDye,
      this.pSplat,
      this.pBlur,
      this.pBloomPre,
      this.pDisplay,
    ].forEach((p) => gl.deleteProgram(p));
    gl.deleteBuffer(this.quad);
    gl.deleteTexture(this.sdfTex);
    [this.velocity, this.pressure, this.dye].forEach((d) => {
      gl.deleteTexture(d.read.tex);
      gl.deleteFramebuffer(d.read.fbo);
      gl.deleteTexture(d.write.tex);
      gl.deleteFramebuffer(d.write.fbo);
    });
    [
      this.divergence,
      this.vorticity,
      this.ppA,
      this.ppB,
      this.bloomTex,
    ].forEach((s) => {
      gl.deleteTexture(s.tex);
      gl.deleteFramebuffer(s.fbo);
    });
  }

  // ── Texture / FBO helpers ────────────────────────────────────────────────

  private makeTex(filter: number): WebGLTexture {
    const { gl } = this;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.floatInternal,
      SIM_W,
      SIM_H,
      0,
      gl.RGBA,
      this.floatType,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private makeFBO(tex: WebGLTexture): FBO {
    const { gl } = this;
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error(`FBO incomplete: 0x${status.toString(16)}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  private makeSingle(): FBO {
    return this.makeFBO(this.makeTex(this.gl.NEAREST));
  }

  private makeDouble(): DoubleFBO {
    const read = this.makeFBO(this.makeTex(this.gl.LINEAR));
    const write = this.makeFBO(this.makeTex(this.gl.LINEAR));
    return {
      read,
      write,
      swap() {
        const t = this.read;
        this.read = this.write;
        this.write = t;
      },
    };
  }

  // ── Draw helpers ──────────────────────────────────────────────────────────

  /** Set up a program, bind a quad and enable the a_pos attribute. Returns attrib loc. */
  private use(prog: WebGLProgram): number {
    const { gl } = this;
    gl.useProgram(prog);
    const a = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    return a;
  }

  private bindTex(
    prog: WebGLProgram,
    name: string,
    tex: WebGLTexture,
    unit: number,
  ): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  }

  private drawTo(fbo: FBO | null): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fbo ? fbo.fbo : null);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  // ── Simulation passes ─────────────────────────────────────────────────────

  private advectVelocity(dt: number): void {
    const { gl } = this;
    const p = this.pAdvect;
    this.use(p);
    this.bindTex(p, "u_velocity", this.velocity.read.tex, 0);
    this.bindTex(p, "u_source", this.velocity.read.tex, 1);
    gl.uniform1f(gl.getUniformLocation(p, "u_dt"), dt);
    // dt-scaled so the per-second decay is the same at any framerate.
    gl.uniform1f(
      gl.getUniformLocation(p, "u_dissipation"),
      Math.pow(VELOCITY_DISS, dt * REF_FPS),
    );
    this.drawTo(this.velocity.write);
    this.velocity.swap();
  }

  private advectDye(dt: number): void {
    const { gl } = this;
    const p = this.pAdvect;
    this.use(p);
    this.bindTex(p, "u_velocity", this.velocity.read.tex, 0);
    this.bindTex(p, "u_source", this.dye.read.tex, 1);
    gl.uniform1f(gl.getUniformLocation(p, "u_dt"), dt);
    // dt-scaled so the per-second fade is the same at any framerate.
    gl.uniform1f(
      gl.getUniformLocation(p, "u_dissipation"),
      Math.pow(DYE_DISS, dt * REF_FPS),
    );
    this.drawTo(this.dye.write);
    this.dye.swap();
  }

  private computeDivergence(): void {
    const { gl } = this;
    const p = this.pDiv;
    this.use(p);
    this.bindTex(p, "u_velocity", this.velocity.read.tex, 0);
    gl.uniform2fv(gl.getUniformLocation(p, "u_texelSize"), TEXEL_SIZE);
    this.drawTo(this.divergence);
  }

  private clearPressure(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pressure.read.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pressure.write.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private solvePressure(): void {
    const { gl } = this;
    const p = this.pJacobi;
    this.use(p);
    gl.uniform2fv(gl.getUniformLocation(p, "u_texelSize"), TEXEL_SIZE);
    gl.uniform1f(gl.getUniformLocation(p, "u_alpha"), ALPHA);
    this.bindTex(p, "u_divergence", this.divergence.tex, 1);

    for (let i = 0; i < JACOBI_ITERS; i++) {
      this.bindTex(p, "u_pressure", this.pressure.read.tex, 0);
      this.drawTo(this.pressure.write);
      this.pressure.swap();
    }
  }

  private subtractGradient(): void {
    const { gl } = this;
    const p = this.pGradSub;
    this.use(p);
    this.bindTex(p, "u_velocity", this.velocity.read.tex, 0);
    this.bindTex(p, "u_pressure", this.pressure.read.tex, 1);
    gl.uniform2fv(gl.getUniformLocation(p, "u_texelSize"), TEXEL_SIZE);
    this.drawTo(this.velocity.write);
    this.velocity.swap();
  }

  private computeVorticity(): void {
    const { gl } = this;
    const p = this.pVort;
    this.use(p);
    this.bindTex(p, "u_velocity", this.velocity.read.tex, 0);
    gl.uniform2fv(gl.getUniformLocation(p, "u_texelSize"), TEXEL_SIZE);
    this.drawTo(this.vorticity);
  }

  private applyVortConfinement(dt: number): void {
    const { gl } = this;
    const p = this.pVortConf;
    this.use(p);
    this.bindTex(p, "u_velocity", this.velocity.read.tex, 0);
    this.bindTex(p, "u_vorticity", this.vorticity.tex, 1);
    gl.uniform2fv(gl.getUniformLocation(p, "u_texelSize"), TEXEL_SIZE);
    gl.uniform1f(gl.getUniformLocation(p, "u_strength"), VORT_STRENGTH);
    gl.uniform1f(gl.getUniformLocation(p, "u_dt"), dt);
    this.drawTo(this.velocity.write);
    this.velocity.swap();
  }

  /** Add the permanent tangential gyre force to the velocity field. */
  private applyBackgroundForce(dt: number): void {
    const { gl } = this;
    const p = this.pForce;
    this.use(p);
    this.bindTex(p, "u_velocity", this.velocity.read.tex, 0);
    gl.uniform2fv(gl.getUniformLocation(p, "u_center"), BG_CENTER);
    gl.uniform1f(gl.getUniformLocation(p, "u_strength"), BG_FORCE);
    gl.uniform1f(gl.getUniformLocation(p, "u_dt"), dt);
    this.drawTo(this.velocity.write);
    this.velocity.swap();
  }

  /** Free-slip velocity wall: keeps the fluid inside Austria's border. */
  private applyVelocityBoundary(): void {
    const { gl } = this;
    const p = this.pBoundaryVel;
    this.use(p);
    this.bindTex(p, "u_velocity", this.velocity.read.tex, 0);
    this.bindTex(p, "u_sdf", this.sdfTex, 1);
    gl.uniform2fv(gl.getUniformLocation(p, "u_texelSize"), TEXEL_SIZE);
    gl.uniform1f(gl.getUniformLocation(p, "u_band"), BORDER_BAND);
    this.drawTo(this.velocity.write);
    this.velocity.swap();
  }

  /** Clip dye strictly outside the border (no interior erosion → mass conserved). */
  private applyDyeBoundary(): void {
    const p = this.pBoundaryDye;
    this.use(p);
    this.bindTex(p, "u_field", this.dye.read.tex, 0);
    this.bindTex(p, "u_sdf", this.sdfTex, 1);
    this.drawTo(this.dye.write);
    this.dye.swap();
  }

  /**
   * Post-process the dye into the display textures (all sim-resolution):
   *   ppB  = Gaussian-blurred dye      (soft borders)
   *   ppA  = blurred bright-pass       (bloom / glow)
   * bloomTex is scratch for the separable bloom blur.
   */
  private postProcess(): void {
    this.gl.viewport(0, 0, SIM_W, SIM_H);
    // Soft-border blur of the dye → ppB (horizontal then vertical).
    this.blur(this.dye.read.tex, this.ppA, BLUR_SPREAD, 0);
    this.blur(this.ppA.tex, this.ppB, 0, BLUR_SPREAD);
    // Bloom: bright-pass of the soft dye, then a wide separable blur → ppA.
    this.prefilter(this.ppB.tex, this.ppA);
    this.blur(this.ppA.tex, this.bloomTex, BLOOM_SPREAD, 0);
    this.blur(this.bloomTex.tex, this.ppA, 0, BLOOM_SPREAD);
  }

  private blur(srcTex: WebGLTexture, dst: FBO, sx: number, sy: number): void {
    const { gl } = this;
    const p = this.pBlur;
    this.use(p);
    this.bindTex(p, "u_tex", srcTex, 0);
    gl.uniform2f(gl.getUniformLocation(p, "u_step"), sx / SIM_W, sy / SIM_H);
    this.drawTo(dst);
  }

  private prefilter(srcTex: WebGLTexture, dst: FBO): void {
    const { gl } = this;
    const p = this.pBloomPre;
    this.use(p);
    this.bindTex(p, "u_tex", srcTex, 0);
    gl.uniform1f(gl.getUniformLocation(p, "u_threshold"), BLOOM_THRESHOLD);
    this.drawTo(dst);
  }

  private drawDisplay(w: number, h: number): void {
    const { gl } = this;
    const p = this.pDisplay;
    this.use(p);
    this.bindTex(p, "u_dye", this.ppB.tex, 0); // blurred (soft) dye
    this.bindTex(p, "u_bloom", this.ppA.tex, 1); // bloom glow
    gl.uniform2f(gl.getUniformLocation(p, "u_resolution"), w, h);
    gl.uniform2fv(gl.getUniformLocation(p, "u_tl"), this.tl);
    gl.uniform2fv(gl.getUniformLocation(p, "u_tr"), this.tr);
    gl.uniform2fv(gl.getUniformLocation(p, "u_bl"), this.bl);
    gl.uniform2fv(gl.getUniformLocation(p, "u_br"), this.br);
    gl.uniform2fv(gl.getUniformLocation(p, "u_origin"), this.sdfOrigin);
    gl.uniform2fv(gl.getUniformLocation(p, "u_scale"), this.sdfScale);
    gl.uniform1f(gl.getUniformLocation(p, "u_saturation"), DISPLAY_SATURATION);
    gl.uniform1f(gl.getUniformLocation(p, "u_brightness"), DISPLAY_BRIGHTNESS);
    gl.uniform1f(gl.getUniformLocation(p, "u_bloomStrength"), BLOOM_STRENGTH);
    // Draw directly into the currently-bound FBO — caller has already restored
    // MapLibre's framebuffer. Never bind null here: MapLibre may be rendering
    // into its own FBO, and null would miss it entirely.
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ── Autonomous injection ─────────────────────────────────────────────────

  /**
   * Queue a new emitter: a fuel colour + a one-time directional velocity jet at
   * a random interior point. The dye is NOT painted here — updateEmitters() eases
   * it in (and out) over the emitter's lifetime so it never pops in.
   * `bornMs` may be in the future to stagger a group of emitters.
   */
  private spawnEmitter(bornMs: number): void {
    if (this.interiorPoints.length === 0 || this.colors.length === 0) return;
    const [u, v] = this.randomInterior();
    const angle = Math.random() * Math.PI * 2;
    const force = SPLAT_FORCE * (0.6 + Math.random() * 0.8);
    this.emitters.push({
      u,
      v,
      color: this.sampleColor(),
      dx: Math.cos(angle) * force,
      dy: Math.sin(angle) * force,
      radius: SPLAT_RADIUS * (0.7 + Math.random() * 0.6), // size variety
      bornMs,
      fired: false,
    });
  }

  /**
   * Per-frame update of all active emitters. Each one fires its velocity jet once
   * (at birth) and paints its dye with a sine envelope (0 → 1 → 0) over its
   * lifetime, so the colour fades in and recedes organically instead of popping.
   */
  private updateEmitters(timeMs: number, dt: number): void {
    // Framerate-independent paint convergence: same approach-rate per real second.
    const paintOp = 1 - Math.pow(1 - PAINT_RATE, dt * REF_FPS);
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      const age = (timeMs - e.bornMs) / SPLAT_FADE_MS;
      if (age < 0) continue; // staggered birth still in the future
      if (age >= 1) {
        this.emitters.splice(i, 1);
        continue;
      }

      // Fire the velocity jet once, when the emitter first becomes active.
      if (!e.fired) {
        e.fired = true;
        this.splatField(
          this.velocity,
          e.u,
          e.v,
          e.radius,
          [e.dx, e.dy, 0, 0],
          -1e9,
          1e9,
          0,
          1,
        );
      }

      // Ease the paint strength in then out, but always toward the full fuel colour
      // so the envelope never pulls dye toward black.
      const env = Math.sin(Math.PI * age) * DYE_STRENGTH;
      const c = e.color;
      this.splatField(
        this.dye,
        e.u,
        e.v,
        e.radius,
        [c[0], c[1], c[2], 1.0],
        0,
        1,
        1,
        paintOp * env,
      );
    }
  }

  private splatField(
    dfbo: DoubleFBO,
    u: number,
    v: number,
    radius: number,
    value: [number, number, number, number],
    clampMin: number,
    clampMax: number,
    paint: number,
    opacity: number,
  ): void {
    const { gl } = this;
    gl.viewport(0, 0, SIM_W, SIM_H);
    const p = this.pSplat;
    this.use(p);
    this.bindTex(p, "u_target", dfbo.read.tex, 0);
    gl.uniform2f(gl.getUniformLocation(p, "u_point"), u, v);
    gl.uniform1f(gl.getUniformLocation(p, "u_radius"), radius);
    gl.uniform4fv(gl.getUniformLocation(p, "u_value"), value);
    gl.uniform1f(gl.getUniformLocation(p, "u_clampMin"), clampMin);
    gl.uniform1f(gl.getUniformLocation(p, "u_clampMax"), clampMax);
    gl.uniform1f(gl.getUniformLocation(p, "u_paint"), paint);
    gl.uniform1f(gl.getUniformLocation(p, "u_opacity"), opacity);
    this.drawTo(dfbo.write);
    dfbo.swap();
  }

  private randomInterior(): [number, number] {
    const pts = this.interiorPoints;
    return pts[Math.floor(Math.random() * pts.length)];
  }

  /** Sample a colour from the current energy mix using weighted random selection. */
  private sampleColor(): [number, number, number] {
    const r = Math.random();
    let cumulative = 0;
    for (const { color, weight } of this.colors) {
      cumulative += weight;
      if (r <= cumulative) return color;
    }
    return this.colors[this.colors.length - 1]?.color ?? [1, 1, 1];
  }
}
