import type { Route } from './types';

// One representative high-voltage interconnection point per neighbor.
// control points bow each path in a unique direction so no two curves look alike.
export const ROUTES: Route[] = [
  {
    country:  'DE',
    crossing: [12.85, 47.97],  // Salzburg / Simbach am Inn corridor
    neighbor: [11.80, 48.42],  // south Bavaria
    control:  [12.10, 48.42],  // bows west
  },
  {
    country:  'CH',
    crossing: [9.68, 47.30],   // Feldkirch / Vorarlberg
    neighbor: [9.20, 47.58],   // St. Gallen canton
    control:  [9.10, 47.22],   // bows southwest
  },
  {
    country:  'IT',
    crossing: [11.50, 46.97],  // Brenner Pass
    neighbor: [11.28, 46.40],  // Bolzano / Alto Adige
    control:  [11.90, 46.62],  // bows east
  },
  {
    country:  'SI',
    crossing: [15.65, 46.68],  // Spielfeld / Šentilj
    neighbor: [15.68, 46.22],  // Maribor area
    control:  [15.18, 46.42],  // bows west
  },
  {
    country:  'HU',
    crossing: [17.12, 47.88],  // Nickelsdorf / Hegyeshalom
    neighbor: [17.52, 47.62],  // Győr direction
    control:  [17.52, 48.08],  // bows north
  },
  {
    country:  'SK',
    crossing: [16.95, 48.12],  // Berg / Kittsee
    neighbor: [17.22, 48.38],  // Bratislava
    control:  [17.30, 47.90],  // bows south
  },
  {
    country:  'CZ',
    crossing: [15.48, 48.82],  // Gmünd / Znojmo corridor
    neighbor: [15.98, 49.18],  // south Moravia
    control:  [15.05, 49.08],  // bows west
  },
];
