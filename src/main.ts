import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { addPlantsLayer, updateClusters } from './plants';

const INITIAL_RADIUS = 20;
const INITIAL_MIN_CAP = 0;

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#0a0a0f' },
      },
    ],
  },
  center: [13.5, 47.5],
  zoom: 7.2,
  minZoom: 6.5,
  maxZoom: 15,
  maxBounds: [[7.5, 45.0], [19.0, 50.5]],
  pitchWithRotate: false,
  dragRotate: false,
});

// ── Slider wiring ─────────────────────────────────────────────────────────────

const radiusSlider = document.getElementById('radius-slider') as HTMLInputElement;
const mincapSlider = document.getElementById('mincap-slider') as HTMLInputElement;
const radiusVal    = document.getElementById('radius-val') as HTMLSpanElement;
const mincapVal    = document.getElementById('mincap-val') as HTMLSpanElement;

function getRadius(): number { return +radiusSlider.value; }
function getMinCap(): number { return +mincapSlider.value; }

let plantsReady = false;

radiusSlider.addEventListener('input', () => {
  radiusVal.textContent = `${radiusSlider.value} km`;
  if (plantsReady) updateClusters(map, getRadius(), getMinCap());
});

mincapSlider.addEventListener('input', () => {
  mincapVal.textContent = `${mincapSlider.value} MW`;
  if (plantsReady) updateClusters(map, getRadius(), getMinCap());
});

// ── Map load ──────────────────────────────────────────────────────────────────

map.on('load', () => {
  map.addSource('austria-states', {
    type: 'geojson',
    data: '/austria-states.geojson',
  });

  map.addLayer({
    id: 'austria-states-fill',
    type: 'fill',
    source: 'austria-states',
    paint: {
      'fill-color': '#12121c',
      'fill-opacity': 1,
    },
  });

  map.addLayer({
    id: 'austria-states-border',
    type: 'line',
    source: 'austria-states',
    paint: {
      'line-color': '#2a2a3a',
      'line-width': 1,
    },
  });

  addPlantsLayer(map, INITIAL_RADIUS, INITIAL_MIN_CAP)
    .then(() => { plantsReady = true; })
    .catch(console.error);
});

// Re-cluster whenever zoom settles (dissolves clusters as user zooms in)
map.on('zoomend', () => {
  if (plantsReady) updateClusters(map, getRadius(), getMinCap());
});
