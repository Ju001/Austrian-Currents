import maplibregl from 'maplibre-gl';
import type { CustomRenderMethodInput } from 'maplibre-gl';
import type { PlasmaRenderer, ColorStop, MercatorXY } from './types';
import type { SDFResult } from '../sdf';

/**
 * MapLibre custom layer that delegates all rendering to a PlasmaRenderer.
 * Pass a factory so the renderer is constructed with the live GL context
 * only after MapLibre has initialised it.
 *
 * Future: swap WebGLPlasmaRenderer for a WebGPUPlasmaRenderer here —
 * everything else stays the same.
 */
export class PlasmaLayer implements maplibregl.CustomLayerInterface {
  readonly id   = 'plasma';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private renderer:    PlasmaRenderer | null = null;
  private map:         maplibregl.Map | null = null;
  private pendingStops: ColorStop[] | null = null;
  private pendingSDF:  SDFResult | null = null;

  constructor(
    private readonly factory: (gl: WebGLRenderingContext) => PlasmaRenderer,
  ) {}

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): void {
    this.map      = map;
    this.renderer = this.factory(gl);
    if (this.pendingStops) {
      this.renderer.setColors(this.pendingStops);
      this.pendingStops = null;
    }
    if (this.pendingSDF) {
      const s = this.pendingSDF;
      this.renderer.setSDF(s.data, s.width, s.height, s.origin, s.scale);
      this.pendingSDF = null;
    }
  }

  render(gl: WebGLRenderingContext, _options: CustomRenderMethodInput): void {
    if (!this.renderer || !this.map) return;

    // Compute Mercator coordinates of the four viewport corners so the
    // plasma is anchored to geography instead of the screen.
    const canvas = gl.canvas as HTMLCanvasElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.renderer.setViewport(
      this.toMerc(0, 0, w, h),
      this.toMerc(w, 0, w, h),
      this.toMerc(0, h, w, h),
      this.toMerc(w, h, w, h),
    );

    this.renderer.render(performance.now());
    // Keep animating — request the next frame from MapLibre
    this.map.triggerRepaint();
  }

  private toMerc(sx: number, sy: number, _w: number, _h: number): MercatorXY {
    const ll = this.map!.unproject([sx, sy]);
    const mc = maplibregl.MercatorCoordinate.fromLngLat(ll);
    return [mc.x, mc.y];
  }

  onRemove(_map: maplibregl.Map, _gl: WebGLRenderingContext): void {
    this.renderer?.destroy();
    this.renderer = null;
    this.map      = null;
  }

  /** Call before or after onAdd — safe either way. */
  setColors(stops: ColorStop[]): void {
    if (this.renderer) {
      this.renderer.setColors(stops);
    } else {
      this.pendingStops = stops;
    }
  }

  /** Call once after buildSDF() — safe before or after onAdd. */
  setSDF(sdf: SDFResult): void {
    if (this.renderer) {
      this.renderer.setSDF(sdf.data, sdf.width, sdf.height, sdf.origin, sdf.scale);
    } else {
      this.pendingSDF = sdf;
    }
  }
}
