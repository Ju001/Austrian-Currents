// ENTSO-E B-code → display fuel name
const B_CODE: Record<string, string> = {
  B01: 'Biomass',
  B02: 'Lignite',
  B03: 'Coal Gas',
  B04: 'Gas',
  B05: 'Hard Coal',
  B06: 'Oil',
  B07: 'Oil Shale',
  B08: 'Peat',
  B09: 'Geothermal',
  B10: 'Pumped Storage',
  B11: 'Hydro',
  B12: 'Hydro',
  B13: 'Marine',
  B14: 'Nuclear',
  B15: 'Other Renewable',
  B16: 'Solar',
  B17: 'Waste',
  B18: 'Wind',
  B19: 'Wind Offshore',
  B20: 'Other',
  B25: 'Energy Storage',
};

// Display colors per fuel — passed as [r,g,b] in 0-1 HDR space for glow
export const FUEL_COLORS: Record<string, [number, number, number]> = {
  Hydro:            [0.05, 0.55, 1.00],
  'Pumped Storage': [0.45, 0.20, 1.00],
  Wind:             [0.10, 0.90, 0.95],
  'Wind Offshore':  [0.10, 0.90, 0.95],
  Solar:            [1.00, 0.82, 0.05],
  Gas:              [1.00, 0.40, 0.10],
  Biomass:          [0.25, 0.85, 0.15],
  Nuclear:          [0.15, 1.00, 0.55],
  'Hard Coal':      [0.55, 0.35, 0.20],
  Lignite:          [0.50, 0.30, 0.15],
  Oil:              [0.70, 0.55, 0.30],
  'Oil Shale':      [0.65, 0.50, 0.25],
  Waste:            [0.60, 0.50, 0.30],
  'Other Renewable':[0.30, 0.70, 0.40],
  Other:            [0.40, 0.45, 0.55],
  'Energy Storage': [0.50, 0.25, 0.90],
};

export interface FuelEntry {
  fuel: string;
  mw: number;
  color: [number, number, number];
}

// Shape of mock/mock_generation.json (and eventual live proxy response)
interface RawMix {
  generation_mw: Record<string, number>;
  pumped_storage_mw?: { generating?: number; pumping?: number };
}

function parseMix(raw: RawMix): FuelEntry[] {
  const totals: Record<string, number> = {};

  for (const [code, mw] of Object.entries(raw.generation_mw)) {
    const fuel = B_CODE[code] ?? 'Other';
    totals[fuel] = (totals[fuel] ?? 0) + mw;
  }

  // Pumped storage generating is net generation (not consumption)
  const psGen = raw.pumped_storage_mw?.generating ?? 0;
  if (psGen > 0) totals['Pumped Storage'] = (totals['Pumped Storage'] ?? 0) + psGen;

  return Object.entries(totals)
    .filter(([, mw]) => mw > 0)
    .map(([fuel, mw]) => ({
      fuel,
      mw,
      color: FUEL_COLORS[fuel] ?? FUEL_COLORS.Other,
    }))
    .sort((a, b) => b.mw - a.mw);
}

export async function fetchMix(url = '/api/generation'): Promise<FuelEntry[]> {
  let res = await fetch(url);
  if (!res.ok && url !== '/mock/mock_generation.json') {
    console.warn(`fetchMix: live API returned ${res.status}, falling back to mock`);
    res = await fetch('/mock/mock_generation.json');
  }
  if (!res.ok) throw new Error(`fetchMix: ${res.status} ${res.statusText}`);
  return parseMix(await res.json() as RawMix);
}

/** Normalise entries to cumulative proportion thresholds [0..1]. */
export function toCumulativeWeights(
  entries: FuelEntry[],
): { color: [number, number, number]; threshold: number }[] {
  const total = entries.reduce((s, e) => s + e.mw, 0);
  if (total === 0) return [];

  let cumulative = 0;
  return entries.map(e => {
    cumulative += e.mw / total;
    return { color: e.color, threshold: cumulative };
  });
}
