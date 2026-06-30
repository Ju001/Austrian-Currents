import type { PlasmaRenderer, ColorStop, MercatorXY } from "./types";

// ── Shaders ───────────────────────────────────────────────────────────────────

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`.trim();

// Domain-warped fractional Brownian motion plasma with SDF border interaction.
// UV is derived from Mercator map coordinates (anchored to geography).
// The SDF texture encodes distance to Austria's border — used to deflect
// the domain warp tangentially near walls (tub effect) and to shade depth.
const FRAG = `
precision highp float;

uniform float u_time;
uniform vec2  u_resolution;

// Viewport corners in Mercator space (bilinear interpolation → pixel geography)
uniform vec2 u_tl, u_tr, u_bl, u_br;

// Signed-distance-field of Austria's border
uniform sampler2D u_sdf;
uniform vec2 u_sdf_origin;  // Mercator top-left of SDF coverage
uniform vec2 u_sdf_scale;   // Mercator width/height of SDF coverage

const int N = 8;
uniform vec3  u_colors[N];
uniform float u_thresholds[N];

// ── Noise ──────────────────────────────────────────────────────────────────

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.13);
  p3 += dot(p3, p3.yzx + 3.333);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i),                  hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) {
    v += a * vnoise(p);
    p  = ROT * p * 2.02;
    a *= 0.5;
  }
  return v;
}

float plasma(vec2 uv, float t) {
  // Three layers precess at different speeds; d1 counter-rotates so
  // layers shear against each other — folding blobs without net drift.
  vec2 d0 = vec2( cos(t * 0.53),  sin(t * 0.53)) * 0.22;
  vec2 d1 = vec2( cos(t * 0.59), -sin(t * 0.59)) * 0.13;
  vec2 d2 = vec2( cos(t * 0.47),  sin(t * 0.47)) * 0.07;

  vec2 p0 = vec2(
    fbm(uv + vec2(0.00, 0.00) + d0),
    fbm(uv + vec2(5.20, 1.30) + d0)
  );
  vec2 p1 = vec2(
    fbm(uv + 1.4 * p0 + vec2(1.70, 9.20) + d1),
    fbm(uv + 1.4 * p0 + vec2(8.30, 2.80) + d1)
  );
  return fbm(uv + 1.3 * p1 + d2);
}

// ── Colour palette ─────────────────────────────────────────────────────────

vec3 pickColor(float f) {
  float e = 0.010;
  vec3 c = u_colors[0];
  c = mix(c, u_colors[1], smoothstep(u_thresholds[0]-e, u_thresholds[0]+e, f));
  c = mix(c, u_colors[2], smoothstep(u_thresholds[1]-e, u_thresholds[1]+e, f));
  c = mix(c, u_colors[3], smoothstep(u_thresholds[2]-e, u_thresholds[2]+e, f));
  c = mix(c, u_colors[4], smoothstep(u_thresholds[3]-e, u_thresholds[3]+e, f));
  c = mix(c, u_colors[5], smoothstep(u_thresholds[4]-e, u_thresholds[4]+e, f));
  c = mix(c, u_colors[6], smoothstep(u_thresholds[5]-e, u_thresholds[5]+e, f));
  c = mix(c, u_colors[7], smoothstep(u_thresholds[6]-e, u_thresholds[6]+e, f));
  return c;
}

// ── Main ───────────────────────────────────────────────────────────────────

void main() {
  float nx =        gl_FragCoord.x / u_resolution.x;
  float ny = 1.0 - (gl_FragCoord.y / u_resolution.y);

  // Geographic UV anchored to the map
  vec2 merc = mix(mix(u_tl, u_tr, nx), mix(u_bl, u_br, nx), ny);
  vec2 uv   = merc * 52.0;

  // ── SDF border interaction ────────────────────────────────────────────

  vec2  sdfUV = (merc - u_sdf_origin) / u_sdf_scale;
  float d     = texture2D(u_sdf, sdfUV).r; // 0 = border, 1 = deepest interior

  // Inward normal via central differences in SDF texture space,
  // then converted to Mercator space so aspect ratio is correct.
  float eps = 1.5 / 256.0;
  float gx  = texture2D(u_sdf, sdfUV + vec2(eps, 0.0)).r
            - texture2D(u_sdf, sdfUV - vec2(eps, 0.0)).r;
  float gy  = texture2D(u_sdf, sdfUV + vec2(0.0, eps)).r
            - texture2D(u_sdf, sdfUV - vec2(0.0, eps)).r;
  vec2 inward  = normalize(vec2(gx / u_sdf_scale.x, gy / u_sdf_scale.y) + vec2(1e-5));
  vec2 tangent = vec2(-inward.y, inward.x); // 90° rotation → border-parallel

  // Wall strength: peaks at border (d=0), fades smoothly inland
  float wall = pow(1.0 - smoothstep(0.0, 0.01, d), 2.0);

  // Deflect the domain-warp UV tangentially near walls.
  // The fluid "slides along" the border instead of passing through it.
  vec2 wallOffset = tangent * wall * 0.10;
  float f = plasma(uv + wallOffset, u_time * 0.18);
  f = clamp(f * 1.15 - 0.075, 0.0, 1.0);

  vec3 col = pickColor(f);

  // HDR glow
  col *= 2.2;
  col  = col / (col + vec3(0.7));
  col *= 0.75 + 0.45 * f;

  gl_FragColor = vec4(col, 0.97);
}
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  vert: WebGLShader,
  frag: WebGLShader,
): WebGLProgram {
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(`Program link error:\n${gl.getProgramInfoLog(prog)}`);
  return prog;
}

// ── WebGLPlasmaRenderer ───────────────────────────────────────────────────────

const MAX_STOPS = 8;
const SENTINEL = 2.0; // threshold value that is never reached (f ∈ [0,1])

export class WebGLPlasmaRenderer implements PlasmaRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly prog: WebGLProgram;
  private readonly buf: WebGLBuffer;

  // Uniform locations
  private readonly uTime: WebGLUniformLocation;
  private readonly uResolution: WebGLUniformLocation;
  private readonly uTL: WebGLUniformLocation;
  private readonly uTR: WebGLUniformLocation;
  private readonly uBL: WebGLUniformLocation;
  private readonly uBR: WebGLUniformLocation;
  private readonly uColors: WebGLUniformLocation;
  private readonly uThresholds: WebGLUniformLocation;
  private readonly uSdf: WebGLUniformLocation;
  private readonly uSdfOrigin: WebGLUniformLocation;
  private readonly uSdfScale: WebGLUniformLocation;

  // Current palette — flat arrays for uniform upload
  private colors = new Float32Array(MAX_STOPS * 3);
  private thresholds = new Float32Array(MAX_STOPS).fill(SENTINEL);

  // Current viewport Mercator corners
  private tl: MercatorXY = [0, 0];
  private tr: MercatorXY = [1, 0];
  private bl: MercatorXY = [0, 1];
  private br: MercatorXY = [1, 1];

  // SDF texture
  private sdfTex: WebGLTexture | null = null;
  private sdfOrigin: MercatorXY = [0, 0];
  private sdfScale: MercatorXY = [1, 1];

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl;

    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    this.prog = link(gl, vert, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);

    // Full-screen quad in clip space (TRIANGLE_STRIP)
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // Fallback SDF: single white texel (d=1.0 = interior everywhere).
    // Keeps wall=0 so no corrupt UV offset before the real SDF loads.
    this.sdfTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.uTime = gl.getUniformLocation(this.prog, "u_time")!;
    this.uResolution = gl.getUniformLocation(this.prog, "u_resolution")!;
    this.uTL = gl.getUniformLocation(this.prog, "u_tl")!;
    this.uTR = gl.getUniformLocation(this.prog, "u_tr")!;
    this.uBL = gl.getUniformLocation(this.prog, "u_bl")!;
    this.uBR = gl.getUniformLocation(this.prog, "u_br")!;
    this.uColors = gl.getUniformLocation(this.prog, "u_colors[0]")!;
    this.uThresholds = gl.getUniformLocation(this.prog, "u_thresholds[0]")!;
    this.uSdf = gl.getUniformLocation(this.prog, "u_sdf")!;
    this.uSdfOrigin = gl.getUniformLocation(this.prog, "u_sdf_origin")!;
    this.uSdfScale = gl.getUniformLocation(this.prog, "u_sdf_scale")!;

    // Default palette (grey) until setColors() is called
    this.colors.fill(0.3);
    this.thresholds.fill(SENTINEL);
    this.thresholds[0] = 1.0;
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
    if (this.sdfTex) gl.deleteTexture(this.sdfTex);

    this.sdfTex = gl.createTexture()!;
    this.sdfOrigin = origin;
    this.sdfScale = scale;

    gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      width,
      height,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  setColors(stops: ColorStop[]): void {
    this.colors.fill(0);
    this.thresholds.fill(SENTINEL);

    const n = Math.min(stops.length, MAX_STOPS);
    for (let i = 0; i < n; i++) {
      this.colors[i * 3] = stops[i].color[0];
      this.colors[i * 3 + 1] = stops[i].color[1];
      this.colors[i * 3 + 2] = stops[i].color[2];
      this.thresholds[i] = stops[i].threshold;
    }
    // Ensure last threshold reaches 1 so the final colour covers to f=1
    if (n > 0) this.thresholds[n - 1] = 1.0;
  }

  render(timeMs: number): void {
    const { gl } = this;
    const w = gl.canvas.width;
    const h = gl.canvas.height;

    // Save MapLibre's GL state we're about to touch
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const prevBuf = gl.getParameter(
      gl.ARRAY_BUFFER_BINDING,
    ) as WebGLBuffer | null;

    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);

    const aPos = gl.getAttribLocation(this.prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1f(this.uTime, timeMs / 1000);
    gl.uniform2f(this.uResolution, w, h);
    gl.uniform2fv(this.uTL, this.tl);
    gl.uniform2fv(this.uTR, this.tr);
    gl.uniform2fv(this.uBL, this.bl);
    gl.uniform2fv(this.uBR, this.br);
    gl.uniform3fv(this.uColors, this.colors);
    gl.uniform1fv(this.uThresholds, this.thresholds);

    // Bind SDF texture to unit 0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
    gl.uniform1i(this.uSdf, 0);
    gl.uniform2fv(this.uSdfOrigin, this.sdfOrigin);
    gl.uniform2fv(this.uSdfScale, this.sdfScale);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Restore
    gl.disableVertexAttribArray(aPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, prevBuf);
    gl.useProgram(prevProg);
  }

  destroy(): void {
    const { gl } = this;
    gl.deleteProgram(this.prog);
    gl.deleteBuffer(this.buf);
    if (this.sdfTex) gl.deleteTexture(this.sdfTex);
  }
}
