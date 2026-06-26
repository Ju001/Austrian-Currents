import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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
  center: [13.5, 47.5],
  zoom: 7.2,
  minZoom: 6.5,
  maxZoom: 15,
  maxBounds: [[7.5, 45.0], [19.0, 50.5]],
  pitchWithRotate: false,
  dragRotate: false,
});

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
});
