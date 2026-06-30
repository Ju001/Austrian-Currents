/** Builds a signed-distance-field texture of a closed polygon ring. */

export interface SDFResult {
  data:   Uint8Array;        // row-major, one byte per texel (0 = border, 255 = deepest interior)
  width:  number;
  height: number;
  origin: [number, number]; // Mercator top-left of the covered region
  scale:  [number, number]; // Mercator width, height of the covered region
}

function lngLatToMerc(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360;
  const sinLat = Math.sin(lat * Math.PI / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return [x, y];
}

function distToSegment(
  ax: number, ay: number, bx: number, by: number,
  px: number, py: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function pointInPolygon(ring: [number, number][], px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Build a 2D SDF texture from a GeoJSON ring in [lng,lat] coordinates.
 * Each texel stores the distance to the nearest border edge, normalised to
 * 0-255 (0 = border, 255 = maximum interior distance).  Outside pixels are 0.
 */
export function buildSDF(
  ringLngLat: [number, number][],
  size = 256,
): SDFResult {
  // Convert to Mercator
  const ring: [number, number][] = ringLngLat.map(([lng, lat]) => lngLatToMerc(lng, lat));

  // Bounding box + 4% padding so the border isn't flush against texture edges
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const padX = (maxX - minX) * 0.04;
  const padY = (maxY - minY) * 0.04;
  minX -= padX; maxX += padX;
  minY -= padY; maxY += padY;

  const scaleX = maxX - minX;
  const scaleY = maxY - minY;
  const n = ring.length;

  const raw = new Float32Array(size * size);
  let maxDist = 0;

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const mx = minX + (i + 0.5) / size * scaleX;
      const my = minY + (j + 0.5) / size * scaleY;

      let minDist = Infinity;
      for (let k = 0; k < n - 1; k++) {
        const d = distToSegment(ring[k][0], ring[k][1], ring[k + 1][0], ring[k + 1][1], mx, my);
        if (d < minDist) minDist = d;
      }

      const dist = pointInPolygon(ring, mx, my) ? minDist : 0;
      raw[j * size + i] = dist;
      if (dist > maxDist) maxDist = dist;
    }
  }

  const data = new Uint8Array(size * size);
  if (maxDist > 0) {
    for (let k = 0; k < raw.length; k++) {
      data[k] = Math.round((raw[k] / maxDist) * 255);
    }
  }

  return {
    data,
    width:  size,
    height: size,
    origin: [minX, minY],
    scale:  [scaleX, scaleY],
  };
}
