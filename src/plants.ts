import maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, Point } from 'geojson';

export const FUEL_COLORS: Record<string, string> = {
  Hydro: '#4fc3f7',
  Wind: '#80deea',
  Solar: '#ffd54f',
  Gas: '#ff8a65',
  Biomass: '#aed581',
  Storage: '#ce93d8',
  'Pumped Storage': '#ce93d8',
  Oil: '#ef9a9a',
  Waste: '#bcaaa4',
  Coal: '#a1887f',
  Nuclear: '#66bb6a',
  Other: '#78909c',
};

const DEFAULT_COLOR = '#78909c';

// Tabler Icons (MIT License – https://tabler.io/icons), paths inlined at build time
function svg(body: string, color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ` +
    `viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );
}

const ICONS: Record<string, (c: string) => string> = {
  Hydro: c => svg(
    '<path d="M6.8 11a6 6 0 1 0 10.396 0l-5.197 -8l-5.2 8z"/>',
    c,
  ),
  Wind: c => svg(
    '<path d="M5 8h8.5a2.5 2.5 0 1 0 -2.34 -3.24"/>' +
    '<path d="M3 12h15.5a2.5 2.5 0 1 1 -2.34 3.24"/>' +
    '<path d="M4 16h5.5a2.5 2.5 0 1 0 -2.34 3.24"/>',
    c,
  ),
  Solar: c => svg(
    '<circle cx="12" cy="12" r="4"/>' +
    '<path d="M12 2v2m0 16v2m8-10h2M2 12h2' +
    'm13.66-7.66-1.42 1.42M7.76 16.24l-1.42 1.42' +
    'm0-11.32 1.42 1.42m8.32 8.32 1.42 1.42"/>',
    c,
  ),
  Gas: c => svg(
    '<path d="M12 12c0 -3.5 -5 -6 -5 -10c1.5 2 4 3 5 5c1 -2 3 -3 3 -5' +
    'c0 4 5 6.5 5 10a8 8 0 1 1 -16 0c0 -3.5 5 -7 8 -10z"/>',
    c,
  ),
  Biomass: c => svg(
    '<path d="M5 21c0 -6 3.5 -10 10 -12c0 6 -3.5 10 -10 12z"/>' +
    '<path d="M9 21c0 -4 .5 -8 3 -12"/>',
    c,
  ),
  Storage: c => svg(
    '<ellipse cx="12" cy="6" rx="8" ry="3"/>' +
    '<path d="M4 6v6a8 3 0 0 0 16 0V6"/>' +
    '<path d="M4 12v6a8 3 0 0 0 16 0v-6"/>',
    c,
  ),
  Oil: c => svg(
    '<path d="M6.8 11a6 6 0 1 0 10.396 0l-5.197 -8l-5.2 8z"/>' +
    '<path d="M8 14h8"/>',
    c,
  ),
  Waste: c => svg(
    '<path d="M4 7h16"/>' +
    '<path d="M10 11v6m4-6v6"/>' +
    '<path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12"/>' +
    '<path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>',
    c,
  ),
  Coal: c => svg(
    '<rect x="3" y="8" width="18" height="11" rx="2"/>' +
    '<path d="M7 8V6m5 2V5m5 3V7"/>',
    c,
  ),
  Nuclear: c => svg(
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M12 9V4m-4.2 6.4-4.3-2.5m8.5 0-4.3 2.5' +
    'm0 3 4.3 2.5m0 0 4.3-2.5m-8.5 0-4.3-2.5"/>',
    c,
  ),
  Other: c => svg(
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 8v4m0 4v.01"/>',
    c,
  ),
};

ICONS['Pumped Storage'] = ICONS['Storage'];

function iconId(fuel: string): string {
  return `plant-${fuel.toLowerCase().replace(/\s+/g, '-')}`;
}

function loadIcon(map: maplibregl.Map, name: string, svgStr: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image(32, 32);
    img.onload = () => { map.addImage(name, img); resolve(); };
    img.onerror = reject;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`;
  });
}

// ── Clustering ────────────────────────────────────────────────────────────────

function haversineKm(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

interface RawProps {
  name: string;
  fuel: string;
  capacity_mw: number;
  owner: string;
  commissioning_year: number | null;
}

type PlantFeature = Feature<Point, RawProps>;

function clusterFeatures(
  features: PlantFeature[],
  radiusKm: number,
  zoom: number,
  minCapMw: number,
): FeatureCollection {
  // Effective radius shrinks 2× per zoom level above base zoom 7
  const BASE_ZOOM = 7;
  const effectiveKm = radiusKm / Math.pow(2, Math.max(0, zoom - BASE_ZOOM));

  const filtered = features.filter(f => (f.properties.capacity_mw ?? 0) >= minCapMw);

  // Group by fuel type
  const byFuel = new Map<string, PlantFeature[]>();
  for (const f of filtered) {
    const fuel = f.properties.fuel;
    if (!byFuel.has(fuel)) byFuel.set(fuel, []);
    byFuel.get(fuel)!.push(f);
  }

  const out: Feature[] = [];

  for (const [fuel, group] of byFuel) {
    // Largest-capacity plant seeds each cluster
    const sorted = [...group].sort(
      (a, b) => (b.properties.capacity_mw ?? 0) - (a.properties.capacity_mw ?? 0),
    );
    const used = new Set<PlantFeature>();

    for (const seed of sorted) {
      if (used.has(seed)) continue;

      const [sLng, sLat] = seed.geometry.coordinates;
      const members: PlantFeature[] = [];

      for (const candidate of sorted) {
        if (used.has(candidate)) continue;
        const [cLng, cLat] = candidate.geometry.coordinates;
        if (haversineKm(sLng, sLat, cLng, cLat) <= effectiveKm) {
          members.push(candidate);
        }
      }
      members.forEach(m => used.add(m));

      // Capacity-weighted centroid
      let totalCap = 0;
      let wLng = 0;
      let wLat = 0;
      for (const m of members) {
        const w = Math.max(m.properties.capacity_mw ?? 0, 1);
        totalCap += m.properties.capacity_mw ?? 0;
        wLng += m.geometry.coordinates[0] * w;
        wLat += m.geometry.coordinates[1] * w;
      }
      const totalW = members.reduce((s, m) => s + Math.max(m.properties.capacity_mw ?? 0, 1), 0);

      out.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [wLng / totalW, wLat / totalW] },
        properties: {
          fuel,
          capacity_mw: totalCap,
          count: members.length,
          name: seed.properties.name,
          owner: seed.properties.owner,
          commissioning_year: seed.properties.commissioning_year,
          // Serialised for MapLibre property access
          names_json: JSON.stringify(
            members.map(m => ({ name: m.properties.name, capacity_mw: m.properties.capacity_mw })),
          ),
        },
      });
    }
  }

  return { type: 'FeatureCollection', features: out };
}

// ── Module state ──────────────────────────────────────────────────────────────

let rawFeatures: PlantFeature[] = [];

// ── Public API ────────────────────────────────────────────────────────────────

export async function addPlantsLayer(
  map: maplibregl.Map,
  radiusKm: number,
  minCapMw: number,
): Promise<void> {
  await Promise.all(
    Object.entries(ICONS).map(([fuel, fn]) =>
      loadIcon(map, iconId(fuel), fn(FUEL_COLORS[fuel] ?? DEFAULT_COLOR)),
    ),
  );

  const res = await fetch('/plants.geojson');
  const geojson = await res.json() as FeatureCollection;
  rawFeatures = geojson.features as PlantFeature[];

  const clustered = clusterFeatures(rawFeatures, radiusKm, map.getZoom(), minCapMw);
  map.addSource('plants', { type: 'geojson', data: clustered });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const colorMatch: any = ['match', ['get', 'fuel'], ...Object.entries(FUEL_COLORS).flat(), DEFAULT_COLOR];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iconMatch: any = [
    'match', ['get', 'fuel'],
    ...Object.keys(ICONS).flatMap(fuel => [fuel, iconId(fuel)]),
    iconId('Other'),
  ];

  // Capacity halo — radius grows with sqrt(MW), extended range for merged clusters
  map.addLayer({
    id: 'plants-halos',
    type: 'circle',
    source: 'plants',
    paint: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'capacity_mw']],
        0, 5, 10, 9, 30, 18, 70, 30] as any,
      'circle-color': colorMatch,
      'circle-opacity': 0.15,
      'circle-stroke-color': colorMatch,
      'circle-stroke-width': 1.5,
      'circle-stroke-opacity': 0.75,
    },
  });

  // Fuel-type icon
  map.addLayer({
    id: 'plants-icons',
    type: 'symbol',
    source: 'plants',
    layout: {
      'icon-image': iconMatch,
      'icon-size': 0.6,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  // Count badge — shown only for merged clusters (count > 1)
  map.addLayer({
    id: 'plants-count',
    type: 'symbol',
    source: 'plants',
    filter: ['>', ['get', 'count'], 1],
    layout: {
      'text-field': ['to-string', ['get', 'count']],
      'text-size': 9,
      'text-offset': [0.85, -0.85],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-font': ['literal', ['Open Sans Bold', 'Arial Unicode MS Bold']],
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': '#000000',
      'text-halo-width': 1.5,
    },
  });

  // ── Popup ──────────────────────────────────────────────────────────────────

  const popup = new maplibregl.Popup({
    closeButton: true,
    closeOnClick: false,
    className: 'plant-popup',
    maxWidth: '280px',
  });

  map.on('click', 'plants-halos', e => {
    if (!e.features?.length) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = e.features[0].properties as any;
    const color = FUEL_COLORS[p.fuel] ?? DEFAULT_COLOR;
    const count: number = p.count ?? 1;

    let html: string;
    if (count === 1) {
      html =
        `<div class="pp-name">${p.name || 'Unnamed plant'}</div>` +
        `<span class="pp-badge" style="background:${color}">${p.fuel}</span>` +
        `<div class="pp-cap">${p.capacity_mw ? `${p.capacity_mw} MW` : 'Capacity unknown'}</div>` +
        (p.commissioning_year ? `<div class="pp-meta">Commissioned ${p.commissioning_year}</div>` : '') +
        (p.owner ? `<div class="pp-meta">${p.owner}</div>` : '');
    } else {
      const entries: { name: string; capacity_mw: number }[] = JSON.parse(p.names_json || '[]');
      const rows = entries.slice(0, 6).map(n =>
        `<div class="pp-plant-row">` +
        `<span>${n.name || 'Unnamed'}</span>` +
        `<span class="pp-plant-cap">${n.capacity_mw ? `${n.capacity_mw} MW` : '—'}</span>` +
        `</div>`,
      ).join('');
      const more = entries.length > 6
        ? `<div class="pp-meta pp-more">+ ${entries.length - 6} more</div>`
        : '';
      html =
        `<div class="pp-name">${count} ${p.fuel} plants</div>` +
        `<span class="pp-badge" style="background:${color}">${p.fuel}</span>` +
        `<div class="pp-cap">${Math.round(p.capacity_mw)} MW combined</div>` +
        `<div class="pp-plant-list">${rows}${more}</div>`;
    }

    popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
  });

  map.on('mouseenter', 'plants-halos', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'plants-halos', () => { map.getCanvas().style.cursor = ''; });
}

export function updateClusters(map: maplibregl.Map, radiusKm: number, minCapMw: number): void {
  if (!rawFeatures.length) return;
  const clustered = clusterFeatures(rawFeatures, radiusKm, map.getZoom(), minCapMw);
  (map.getSource('plants') as maplibregl.GeoJSONSource).setData(clustered);
}
