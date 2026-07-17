// All GLSL sources for the Navier-Stokes fluid simulation.
// Every fragment shader shares this single vertex shader.
export const VERT = `
attribute vec2 a_pos;
varying   vec2 v_uv;
void main() {
  v_uv        = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`.trim();

// ── Advect a scalar/vector field through a velocity field (semi-Lagrangian) ──
export const ADVECT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_velocity;
uniform sampler2D u_source;
uniform float u_dt;
uniform float u_dissipation;
void main() {
  vec2 vel   = texture2D(u_velocity, v_uv).xy;
  vec2 coord = v_uv - vel * u_dt;
  gl_FragColor = texture2D(u_source, coord) * u_dissipation;
}`.trim();

// ── Compute divergence of the velocity field ───────────────────────────────
export const DIVERGENCE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_velocity;
uniform vec2 u_texelSize;
void main() {
  float L = texture2D(u_velocity, v_uv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture2D(u_velocity, v_uv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture2D(u_velocity, v_uv - vec2(0.0, u_texelSize.y)).y;
  float T = texture2D(u_velocity, v_uv + vec2(0.0, u_texelSize.y)).y;
  float div = 0.5 * (R - L + T - B) / u_texelSize.x;
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}`.trim();

// ── One Jacobi iteration for solving ∇²P = div ────────────────────────────
export const JACOBI = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_pressure;
uniform sampler2D u_divergence;
uniform vec2 u_texelSize;
uniform float u_alpha;   // -h²
void main() {
  float L = texture2D(u_pressure,   v_uv - vec2(u_texelSize.x, 0.0)).x;
  float R = texture2D(u_pressure,   v_uv + vec2(u_texelSize.x, 0.0)).x;
  float B = texture2D(u_pressure,   v_uv - vec2(0.0, u_texelSize.y)).x;
  float T = texture2D(u_pressure,   v_uv + vec2(0.0, u_texelSize.y)).x;
  float d = texture2D(u_divergence, v_uv).x;
  float p = (L + R + B + T + u_alpha * d) * 0.25;
  gl_FragColor = vec4(p, 0.0, 0.0, 1.0);
}`.trim();

// ── Subtract pressure gradient from velocity (projection step) ─────────────
export const GRADIENT_SUBTRACT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_velocity;
uniform sampler2D u_pressure;
uniform vec2 u_texelSize;
void main() {
  float pL = texture2D(u_pressure, v_uv - vec2(u_texelSize.x, 0.0)).x;
  float pR = texture2D(u_pressure, v_uv + vec2(u_texelSize.x, 0.0)).x;
  float pB = texture2D(u_pressure, v_uv - vec2(0.0, u_texelSize.y)).x;
  float pT = texture2D(u_pressure, v_uv + vec2(0.0, u_texelSize.y)).x;
  vec2 vel  = texture2D(u_velocity, v_uv).xy;
  vel -= vec2(pR - pL, pT - pB) * 0.5 / u_texelSize.x;
  gl_FragColor = vec4(vel, 0.0, 1.0);
}`.trim();

// ── Compute scalar vorticity (curl of velocity) ────────────────────────────
// Raw finite-difference curl, no /texelSize — keeps values in velocity units
// so vorticity confinement can use u_strength values similar to reference impls.
export const VORTICITY = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_velocity;
uniform vec2 u_texelSize;
void main() {
  float L = texture2D(u_velocity, v_uv - vec2(u_texelSize.x, 0.0)).y;
  float R = texture2D(u_velocity, v_uv + vec2(u_texelSize.x, 0.0)).y;
  float B = texture2D(u_velocity, v_uv - vec2(0.0, u_texelSize.y)).x;
  float T = texture2D(u_velocity, v_uv + vec2(0.0, u_texelSize.y)).x;
  gl_FragColor = vec4(R - L - T + B, 0.0, 0.0, 1.0);
}`.trim();

// ── Vorticity confinement: amplify existing vortices ───────────────────────
// Matches Pablo Flores reference: gradient of |curl| scaled by 0.5/texelSize,
// normalised to a unit vector, then rotated perpendicular to grad and scaled by
// u_strength * C.  Velocity is clamped to prevent half-float overflow.
export const VORT_CONFINE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_velocity;
uniform sampler2D u_vorticity;
uniform vec2  u_texelSize;
uniform float u_strength;
uniform float u_dt;
void main() {
  float L = abs(texture2D(u_vorticity, v_uv - vec2(u_texelSize.x, 0.0)).x);
  float R = abs(texture2D(u_vorticity, v_uv + vec2(u_texelSize.x, 0.0)).x);
  float B = abs(texture2D(u_vorticity, v_uv - vec2(0.0, u_texelSize.y)).x);
  float T = abs(texture2D(u_vorticity, v_uv + vec2(0.0, u_texelSize.y)).x);
  float C = texture2D(u_vorticity, v_uv).x;
  vec2  force = vec2(abs(T) - abs(B), abs(R) - abs(L)) * 0.5 / u_texelSize;
  force /= length(force) + 0.0001;
  force *= u_strength * C;
  force.y *= -1.0;
  vec2  vel = texture2D(u_velocity, v_uv).xy + force * u_dt;
  gl_FragColor = vec4(clamp(vel, -3.0, 3.0), 0.0, 1.0);
}`.trim();

// ── Permanent background gyre: a tangential body force on the velocity ────
// Keeps the basin sloshing in a slow circle even after splat jets decay.
// The force is perpendicular to (uv - centre), divided by radius (clamped near
// the centre) so the tangential speed is roughly constant rather than blowing
// up at the rim. A divergence-free field, so the pressure projection preserves it.
export const FORCE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_velocity;
uniform vec2  u_center;
uniform float u_strength;
uniform float u_dt;
void main() {
  vec2 vel = texture2D(u_velocity, v_uv).xy;
  vec2 d   = v_uv - u_center;
  vec2 tangent = vec2(-d.y, d.x) / max(length(d), 0.15);
  vel += tangent * u_strength * u_dt;
  gl_FragColor = vec4(vel, 0.0, 1.0);
}`.trim();

// ── Free-slip velocity wall at Austria's border (mass-conserving) ─────────
// sdfUV == simUV because both span the same Mercator bounding box.
// SDF .r = normalised distance: 0 at the border AND outside, increasing inward,
// so ∇d is the inward normal. We keep fluid *inside* the country by cancelling
// only the OUTWARD-normal velocity component in a band just inside the border —
// the fluid slides along the outline instead of crossing it. Strictly outside
// (d≈0) is a solid wall with zero flow.
export const BOUNDARY_VELOCITY = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_velocity;
uniform sampler2D u_sdf;
uniform vec2  u_texelSize;
uniform float u_band;     // border band width in SDF (distance) units
void main() {
  float d   = texture2D(u_sdf, v_uv).r;
  vec2  vel = texture2D(u_velocity, v_uv).xy;

  if (d <= 0.0001) {                 // border / outside → solid, no flow
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  if (d < u_band) {                  // inner band → free-slip
    float dl = texture2D(u_sdf, v_uv - vec2(u_texelSize.x, 0.0)).r;
    float dr = texture2D(u_sdf, v_uv + vec2(u_texelSize.x, 0.0)).r;
    float db = texture2D(u_sdf, v_uv - vec2(0.0, u_texelSize.y)).r;
    float dt = texture2D(u_sdf, v_uv + vec2(0.0, u_texelSize.y)).r;
    vec2  n  = normalize(vec2(dr - dl, dt - db) + vec2(1e-6)); // inward normal
    vec2  outward = -n;
    float vOut = dot(vel, outward);
    if (vOut > 0.0) vel -= vOut * outward;   // remove flow leaving the country
  }
  gl_FragColor = vec4(vel, 0.0, 1.0);
}`.trim();

// ── Dye clip: zero ONLY strictly outside the border ──────────────────────
// No soft-band attenuation, so interior dye is never eroded frame-to-frame —
// the total amount of each colour is conserved (the velocity wall keeps it in).
export const BOUNDARY_DYE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_sdf;
void main() {
  float d   = texture2D(u_sdf, v_uv).r;
  vec4  val = texture2D(u_field, v_uv);
  float inside = step(0.0001, d);    // 1 inside, 0 strictly outside
  gl_FragColor = vec4(val.rgb * inside, val.a);
}`.trim();

// ── Inject a Gaussian blob (dye or velocity impulse) ─────────────────────
export const SPLAT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_target;
uniform vec2  u_point;
uniform float u_radius;    // in UV units
uniform vec4  u_value;     // colour (paint) or velocity impulse (add)
uniform float u_clampMin;  // dye: 0.0   velocity: -1e9 (effectively no clamp)
uniform float u_clampMax;  // dye: 1.0   velocity:  1e9
uniform float u_paint;     // 0 = additive (velocity), 1 = paint/replace (dye)
uniform float u_opacity;   // dt-scaled paint rate (dye); 1.0 for velocity
void main() {
  vec4  base     = texture2D(u_target, v_uv);
  vec2  d        = v_uv - u_point;
  float r        = length(d) / u_radius;
  float strength = 1.0 - smoothstep(0.55, 0.6, r);
  // Velocity ADDS (jets accumulate momentum). Dye PAINTS — it replaces toward the
  // pure colour, so overlapping splats never sum hues into white. u_opacity scales
  // the paint rate so the per-frame mix is framerate-independent.
  vec4  added    = base + strength * u_value;
  vec4  painted  = mix(base, u_value, strength * u_opacity);
  vec4  result   = mix(added, painted, u_paint);
  // Clamp only constrains dye to [0,1]; velocity passes a wide range so its
  // negative / large components survive (otherwise the flow field collapses).
  gl_FragColor   = clamp(result, u_clampMin, u_clampMax);
}`.trim();

// ── Separable Gaussian blur (9-tap). Run once per axis. ───────────────────
// u_step is the per-tap offset along one axis (texel size × spread).
export const BLUR = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_step;
void main() {
  vec4 sum = texture2D(u_tex, v_uv) * 0.227027;
  sum += (texture2D(u_tex, v_uv + u_step) + texture2D(u_tex, v_uv - u_step)) * 0.1945946;
  sum += (texture2D(u_tex, v_uv + 2.0*u_step) + texture2D(u_tex, v_uv - 2.0*u_step)) * 0.1216216;
  sum += (texture2D(u_tex, v_uv + 3.0*u_step) + texture2D(u_tex, v_uv - 3.0*u_step)) * 0.054054;
  sum += (texture2D(u_tex, v_uv + 4.0*u_step) + texture2D(u_tex, v_uv - 4.0*u_step)) * 0.016216;
  gl_FragColor = sum;
}`.trim();

// ── Bloom bright-pass: keep only the part of each colour above a threshold ─
export const BLOOM_PREFILTER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_threshold;
void main() {
  vec3 c = max(texture2D(u_tex, v_uv).rgb, vec3(0.0));
  float b = max(max(c.r, c.g), c.b);
  float k = max(b - u_threshold, 0.0) / max(b, 1e-4);
  gl_FragColor = vec4(c * k, 1.0);
}`.trim();

// ── Display dye texture mapped through Mercator viewport corners ──────────
export const DISPLAY = `
precision highp float;
varying vec2 v_uv;   // not used (we use gl_FragCoord)
uniform sampler2D u_dye;     // blurred dye (soft borders)
uniform sampler2D u_bloom;   // blurred bright-pass (glow)
uniform vec2 u_resolution;
uniform vec2 u_tl, u_tr, u_bl, u_br;  // viewport Mercator corners
uniform vec2 u_origin;   // simulation domain Mercator origin
uniform vec2 u_scale;    // simulation domain Mercator size
uniform float u_saturation;    // >1 deepens hue against wash-out
uniform float u_brightness;    // >1 lifts faded dye back to vivid
uniform float u_bloomStrength; // glow intensity

void main() {
  float nx  =       gl_FragCoord.x / u_resolution.x;
  float ny  = 1.0 - gl_FragCoord.y / u_resolution.y;
  vec2  merc   = mix(mix(u_tl, u_tr, nx), mix(u_bl, u_br, nx), ny);
  vec2  simUV  = (merc - u_origin) / u_scale;

  if (any(lessThan(simUV, vec2(0.0))) || any(greaterThan(simUV, vec2(1.0)))) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec3 col = max(texture2D(u_dye, simUV).rgb, vec3(0.0));

  // Alpha is derived from raw dye intensity BEFORE display processing, so that
  // faded dye fades to transparent rather than becoming a saturated ghost colour.
  // The smoothstep cuts the long exponential-decay tail: dye below ~0.05 is fully
  // transparent instead of lingering as a dark film over the map.
  float m = max(col.r, max(col.g, col.b));
  float a = smoothstep(0.15, 0.45, m) * 0.92;

  // Advection blends hues toward grey and decay dims them, so the dye drifts
  // washed-out. Counter both at display time:
  //   1. saturation  — push colour away from its luma (grey) back toward hue
  //   2. brightness  — lift the value so faded dye still reads vividly
  float luma = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(luma), col, u_saturation);          // re-saturate
  col = clamp(col * u_brightness, 0.0, 1.0);          // re-energise

  // Add bloom glow (blurred bright-pass), spreads a soft halo beyond the dye.
  vec3 bloom = max(texture2D(u_bloom, simUV).rgb, vec3(0.0));
  col = clamp(col + bloom * u_bloomStrength, 0.0, 1.0);

  // MapLibre uses premultiplied alpha blending (gl.ONE, gl.ONE_MINUS_SRC_ALPHA).
  gl_FragColor = vec4(col * a, a);
}`.trim();
