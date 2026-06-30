import maplibregl from 'maplibre-gl';
import type { CustomRenderMethodInput } from 'maplibre-gl';
import type { ColorWeight, MercatorXY } from './types';
import { WebGLFluid } from './WebGLFluid';
import type { SDFResult } from '../sdf';

export class FluidLayer implements maplibregl.CustomLayerInterface {
  readonly id   = 'fluid';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private fluid:        WebGLFluid | null = null;
  private map:          maplibregl.Map  | null = null;
  private pendingColors: ColorWeight[]  | null = null;
  private pendingSDF:   SDFResult       | null = null;

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): void {
    this.map = map;
    try {
      this.fluid = new WebGLFluid(gl);
    } catch (e) {
      console.error('FluidLayer: WebGL fluid init failed —', e);
      return;
    }
    if (this.pendingColors) {
      this.fluid.setColors(this.pendingColors);
      this.pendingColors = null;
    }
    if (this.pendingSDF) {
      const s = this.pendingSDF;
      this.fluid.setSDF(s.data, s.width, s.height, s.origin, s.scale);
      this.pendingSDF = null;
    }
  }

  render(gl: WebGLRenderingContext, _options: CustomRenderMethodInput): void {
    if (!this.fluid || !this.map) return;
    const canvas = gl.canvas as HTMLCanvasElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    this.fluid.setViewport(
      this.toMerc(0, 0, w, h),
      this.toMerc(w, 0, w, h),
      this.toMerc(0, h, w, h),
      this.toMerc(w, h, w, h),
    );
    this.fluid.render(performance.now());
    this.map.triggerRepaint();
  }

  private toMerc(sx: number, sy: number, _w: number, _h: number): MercatorXY {
    const ll = this.map!.unproject([sx, sy]);
    const mc = maplibregl.MercatorCoordinate.fromLngLat(ll);
    return [mc.x, mc.y];
  }

  onRemove(_map: maplibregl.Map, _gl: WebGLRenderingContext): void {
    this.fluid?.destroy();
    this.fluid = null;
    this.map   = null;
  }

  setColors(weights: ColorWeight[]): void {
    if (this.fluid) this.fluid.setColors(weights);
    else this.pendingColors = weights;
  }

  setSDF(sdf: SDFResult): void {
    if (this.fluid) this.fluid.setSDF(sdf.data, sdf.width, sdf.height, sdf.origin, sdf.scale);
    else this.pendingSDF = sdf;
  }
}
