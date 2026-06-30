export type MercatorXY = [number, number];

export interface ColorWeight {
  color: [number, number, number]; // RGB in 0-1 HDR space
  weight: number;                  // relative weight (will be normalised)
}

export interface FluidRenderer {
  setColors(weights: ColorWeight[]): void;
  setViewport(tl: MercatorXY, tr: MercatorXY, bl: MercatorXY, br: MercatorXY): void;
  setSDF(
    data:   Uint8Array,
    width:  number,
    height: number,
    origin: MercatorXY,
    scale:  MercatorXY,
  ): void;
  render(timeMs: number): void;
  destroy(): void;
}
