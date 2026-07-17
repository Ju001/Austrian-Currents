import maplibregl from 'maplibre-gl';
import type { CrossBorderFlow } from '../energyMix';
import { ROUTES } from './routes';

interface Particle {
  routeIdx: number;
  t: number;        // 0 → 1, parametric progress along path
  speed: number;    // t-units per ms
  reverse: boolean; // true = export (crossing → neighbor)
}

const RATE_PER_GW   = 8;
const MAX_PER_ROUTE = 20;
const BASE_SPEED    = 1 / 3500; // full traversal in 3.5 s
const GLOW_PX       = 10;       // head glow radius at 1× DPR
const TAIL_STEPS    = 6;        // number of trailing samples
const TAIL_SPACING  = 0.022;    // t-units between tail samples

export class CrossBorderLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx:    CanvasRenderingContext2D;
  private readonly map:    maplibregl.Map;

  private flows:      Map<string, number> = new Map();
  private particles:  Particle[]          = [];
  private accumulate: number[]            = new Array(ROUTES.length).fill(0);
  private lastMs      = 0;
  private rafId       = 0;

  constructor(map: maplibregl.Map) {
    this.map = map;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'position:absolute;top:0;left:0;pointer-events:none;z-index:2';

    const container = map.getContainer();
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);

    this.rafId = requestAnimationFrame(t => this.frame(t));
  }

  setFlows(flows: CrossBorderFlow[]): void {
    const prev = this.flows;
    this.flows = new Map(flows.map(f => [f.country, f.mw]));

    for (let i = 0; i < ROUTES.length; i++) {
      const mw = this.flows.get(ROUTES[i].country) ?? 0;
      const wasActive = (prev.get(ROUTES[i].country) ?? 0) !== 0;
      if (mw !== 0 && !wasActive) this.accumulate[i] = 1;
    }

    this.particles = this.particles.filter(p => {
      const mw = this.flows.get(ROUTES[p.routeIdx].country) ?? 0;
      return mw !== 0 && (mw < 0) === p.reverse;
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.canvas.remove();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private resize(): void {
    const c   = this.map.getContainer();
    const dpr = devicePixelRatio;
    this.canvas.width        = c.clientWidth  * dpr;
    this.canvas.height       = c.clientHeight * dpr;
    this.canvas.style.width  = c.clientWidth  + 'px';
    this.canvas.style.height = c.clientHeight + 'px';
  }

  private proj(ll: [number, number]): [number, number] {
    const p = this.map.project(ll);
    const d = devicePixelRatio;
    return [p.x * d, p.y * d];
  }

  private quad(
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    t: number,
  ): [number, number] {
    const mt = 1 - t;
    return [
      mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
      mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1],
    ];
  }

  private frame(ms: number): void {
    if (this.lastMs === 0) this.lastMs = ms;
    const dt = Math.min(ms - this.lastMs, 50);
    this.lastMs = ms;

    const { ctx, canvas } = this;
    if (canvas.width === 0) {
      this.rafId = requestAnimationFrame(t => this.frame(t));
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const pts = ROUTES.map(r => ({
      p0: this.proj(r.neighbor),
      p1: this.proj(r.control),
      p2: this.proj(r.crossing),
    }));

    const dpr = devicePixelRatio;

    // ── Channel lines ───────────────────────────────────────────────────────
    for (let i = 0; i < ROUTES.length; i++) {
      const mw = this.flows.get(ROUTES[i].country) ?? 0;
      if (mw === 0) continue;
      const { p0, p1, p2 } = pts[i];

      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.quadraticCurveTo(p1[0], p1[1], p2[0], p2[1]);

      // Outer glow
      ctx.strokeStyle = 'rgba(140,200,255,0.06)';
      ctx.lineWidth   = 6 * dpr;
      ctx.stroke();

      // Inner line
      ctx.strokeStyle = 'rgba(180,220,255,0.14)';
      ctx.lineWidth   = 1.2 * dpr;
      ctx.stroke();
    }

    // ── Spawn particles ─────────────────────────────────────────────────────
    for (let i = 0; i < ROUTES.length; i++) {
      const mw = this.flows.get(ROUTES[i].country) ?? 0;
      if (mw === 0) { this.accumulate[i] = 0; continue; }

      const rate = (RATE_PER_GW * Math.abs(mw) / 1000) / 1000;
      this.accumulate[i] += rate * dt;

      let active = this.particles.filter(p => p.routeIdx === i).length;
      while (this.accumulate[i] >= 1 && active < MAX_PER_ROUTE) {
        this.accumulate[i] -= 1;
        this.particles.push({
          routeIdx: i,
          t:        0,
          speed:    BASE_SPEED * (0.8 + Math.random() * 0.4),
          reverse:  mw < 0,
        });
        active++;
      }
    }

    // ── Draw particles with comet tails ─────────────────────────────────────
    this.particles = this.particles.filter(p => {
      p.t += p.speed * dt;
      if (p.t >= 1) return false;

      const mw = this.flows.get(ROUTES[p.routeIdx].country) ?? 0;
      if (mw === 0) return false;

      const { p0, p1, p2 } = pts[p.routeIdx];

      // head position in bezier space; direction of travel along the curve
      const head = p.reverse ? 1 - p.t : p.t;
      const dir  = p.reverse ? -1 : 1; // tail goes opposite to travel

      for (let s = TAIL_STEPS; s >= 0; s--) {
        const tSample = head - dir * s * TAIL_SPACING;
        if (tSample < 0 || tSample > 1) continue;

        const [x, y] = this.quad(p0, p1, p2, tSample);
        const frac   = 1 - s / TAIL_STEPS; // 1 = head, 0 = tail tip
        const r      = GLOW_PX * dpr * (0.25 + 0.75 * frac);

        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0,   `rgba(225,240,255,${(frac * 0.95).toFixed(2)})`);
        g.addColorStop(0.3, `rgba(180,215,255,${(frac * 0.45).toFixed(2)})`);
        g.addColorStop(1,   `rgba(140,195,255,0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      return true;
    });

    this.rafId = requestAnimationFrame(t => this.frame(t));
  }
}
