export interface ColorStop {
  color: [number, number, number];  // RGB in 0-1 HDR space
  threshold: number;                 // cumulative proportion 0-1
}

/** Mercator [x, y] in 0-1 world space (MapLibre convention). */
export type MercatorXY = [number, number];

/**
 * Renderer interface — implement this for WebGL, WebGPU, or Canvas2D.
 * The MapLibre layer calls setColors() when the mix changes, setViewport()
 * every frame with fresh corner coordinates, and render() to draw.
 */
export interface PlasmaRenderer {
  /** Update the colour palette from a fresh energy mix. */
  setColors(stops: ColorStop[]): void;
  /**
   * Called every frame with the Mercator coordinates of the four viewport
   * corners so the fluid is anchored to geography, not the screen.
   * Order: top-left, top-right, bottom-left, bottom-right.
   */
  setViewport(tl: MercatorXY, tr: MercatorXY, bl: MercatorXY, br: MercatorXY): void;
  /**
   * Upload a precomputed signed-distance-field texture of the border polygon.
   * data: row-major Uint8Array (0 = border, 255 = deepest interior point).
   * origin / scale: Mercator coverage of the texture.
   * Call once after the renderer is constructed.
   */
  setSDF(
    data:   Uint8Array,
    width:  number,
    height: number,
    origin: MercatorXY,
    scale:  MercatorXY,
  ): void;
  /** Draw one frame. timeMs is a monotonic ms timestamp (e.g. performance.now()). */
  render(timeMs: number): void;
  /** Release all GPU resources. */
  destroy(): void;
}
