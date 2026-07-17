import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { fetchMix, type FuelEntry, type CrossBorderFlow } from './energyMix';
import { FluidLayer } from './fluid/layer';
import type { ColorWeight } from './fluid/types';
import { buildSDF } from './sdf';
import { CrossBorderLayer } from './crossBorder/layer';

// ── Map ───────────────────────────────────────────────────────────────────────

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#0a0a0f' },
      },
    ],
  },
  bounds: [[9.4, 46.3], [17.2, 49.1]],
  fitBoundsOptions: { padding: 32 },
  minZoom: 4,
  maxZoom: 15,
  pitchWithRotate: false,
  dragRotate: false,
});

// ── Fluid layer ───────────────────────────────────────────────────────────────

const fluidLayer = new FluidLayer();

fetch('/austria-mask.geojson')
  .then(r => r.json())
  .then((mask: { geometry: { coordinates: [number, number][][] } }) => {
    const ring = mask.geometry.coordinates[1] as [number, number][];
    const sdf  = buildSDF(ring, 512);
    fluidLayer.setSDF(sdf);
  })
  .catch(err => console.error('SDF build failed:', err));

// ── Bootstrap ─────────────────────────────────────────────────────────────────

map.on('load', () => {
  // 1. Fluid simulation
  map.addLayer(fluidLayer);

  // 2. Outside-Austria mask
  map.addSource('austria-mask', {
    type: 'geojson',
    data: '/austria-mask.geojson',
  });
  map.addLayer({
    id:     'austria-mask-fill',
    type:   'fill',
    source: 'austria-mask',
    paint:  { 'fill-color': '#0a0a0f', 'fill-opacity': 1 },
  });

  // 3. State borders
  map.addSource('austria-states', {
    type: 'geojson',
    data: '/austria-states.geojson',
  });
  map.addLayer({
    id:     'austria-states-border',
    type:   'line',
    source: 'austria-states',
    paint:  {
      'line-color': 'rgba(255,255,255,0.18)',
      'line-width': 0.9,
    },
  });

  // 4. Cross-border particle overlay
  const crossBorderLayer = new CrossBorderLayer(map);

  // 5. Energy mix + cross-border flows
  async function refreshMix() {
    try {
      const url = import.meta.env.DEV ? '/mock/mock_generation.json' : '/api/generation';
      const { fuels, crossBorder } = await fetchMix(url);
      const weights = toColorWeights(fuels);
      fluidLayer.setColors(weights);
      renderLegend(fuels);
      buildSliders(fuels, weights);
      crossBorderLayer.setFlows(crossBorder);
      renderCrossBorder(crossBorder);
    } catch (err) {
      console.error('Failed to load energy mix:', err);
    }
  }

  refreshMix();
  if (!import.meta.env.DEV) {
    setInterval(refreshMix, 15 * 60 * 1000);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function toColorWeights(entries: FuelEntry[]): ColorWeight[] {
  const total = entries.reduce((s, e) => s + e.mw, 0);
  if (total === 0) return [];
  return entries.map(e => ({ color: e.color, weight: e.mw / total }));
}

// ── Generation legend ─────────────────────────────────────────────────────────

function renderLegend(entries: FuelEntry[]) {
  const panel = document.getElementById('legend')!;
  const total = entries.reduce((s, e) => s + e.mw, 0);
  panel.innerHTML = entries.map(e => {
    const pct       = total > 0 ? ((e.mw / total) * 100).toFixed(1) : '0.0';
    const [r, g, b] = e.color.map(v => Math.round(Math.min(v, 1) * 255));
    const hex       = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    return `<div class="leg-row">
      <span class="leg-dot" style="background:${hex}"></span>
      <span class="leg-label">${e.fuel}</span>
      <span class="leg-pct">${pct}%</span>
    </div>`;
  }).join('');
}

// ── Mix sliders ───────────────────────────────────────────────────────────────

function buildSliders(entries: FuelEntry[], initialWeights: ColorWeight[]) {
  const panel = document.getElementById('mix-controls')!;
  panel.querySelectorAll('.ctrl-row').forEach(el => el.remove());

  const maxW    = Math.max(...entries.map(e => e.mw));
  const weights = entries.map(e => Math.round((e.mw / maxW) * 100));

  entries.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'ctrl-row';

    const dot = document.createElement('span');
    dot.className = 'ctrl-dot';
    const [r, g, b] = entry.color.map(v => Math.round(Math.min(v, 1) * 255));
    dot.style.cssText = `background:rgb(${r},${g},${b});box-shadow:0 0 4px rgb(${r},${g},${b})`;

    const label = document.createElement('span');
    label.className = 'ctrl-label';
    label.textContent = entry.fuel;

    const slider = document.createElement('input');
    slider.type      = 'range';
    slider.min       = '0';
    slider.max       = '100';
    slider.step      = '1';
    slider.value     = String(weights[i]);
    slider.className = 'ctrl-slider';

    slider.addEventListener('input', () => {
      weights[i] = parseFloat(slider.value);
      const updated = entries.map((e, j) => ({ ...e, mw: weights[j] }));
      fluidLayer.setColors(toColorWeights(updated));
      renderLegend(updated);
    });

    row.append(dot, label, slider);
    panel.appendChild(row);
  });

  void initialWeights;
}

// ── Cross-border panel ────────────────────────────────────────────────────────

function renderCrossBorder(flows: CrossBorderFlow[]) {
  const panel = document.getElementById('cross-border')!;
  panel.querySelectorAll('.cb-row').forEach(el => el.remove());

  flows.forEach(f => {
    const row     = document.createElement('div');
    row.className = 'cb-row';
    const isImport = f.mw > 0;
    row.innerHTML =
      `<span class="cb-arrow">${isImport ? '◀' : '▶'}</span>` +
      `<span class="cb-country">${f.country}</span>` +
      `<span class="cb-mw">${Math.round(Math.abs(f.mw))} MW</span>`;
    panel.appendChild(row);
  });
}
