// ENTSO-E B-code → display fuel name
const B_CODE: Record<string, string> = {
  B01: "Biomass",
  B02: "Lignite",
  B03: "Coal Gas",
  B04: "Gas",
  B05: "Hard Coal",
  B06: "Oil",
  B07: "Oil Shale",
  B08: "Peat",
  B09: "Geothermal",
  B10: "Pumped Storage",
  B11: "Hydro",
  B12: "Hydro",
  B13: "Marine",
  B14: "Nuclear",
  B15: "Other Renewable",
  B16: "Solar",
  B17: "Waste",
  B18: "Wind Offshore",
  B19: "Wind",
  B20: "Other",
  B25: "Energy Storage",
};

// Display colors per fuel — passed as [r,g,b] in 0-1 HDR space for glow
export const FUEL_COLORS: Record<string, [number, number, number]> = {
  Hydro: [0.05, 0.55, 1.0],
  "Pumped Storage": [0.45, 0.2, 1.0],
  Wind: [0.5, 0.85, 0.9],
  "Wind Offshore": [0.1, 0.9, 0.95],
  Solar: [1.0, 0.82, 0.05],
  Gas: [1.0, 0.4, 0.1],
  Biomass: [0.25, 0.85, 0.15],
  Nuclear: [0.15, 1.0, 0.55],
  "Hard Coal": [0.55, 0.35, 0.2],
  Lignite: [0.5, 0.3, 0.15],
  Oil: [0.7, 0.55, 0.3],
  "Oil Shale": [0.65, 0.5, 0.25],
  Waste: [0.6, 0.5, 0.3],
  "Other Renewable": [0.3, 0.7, 0.4],
  Other: [0.4, 0.45, 0.55],
  "Energy Storage": [0.5, 0.25, 0.9],
};

export interface FuelEntry {
  fuel: string;
  mw: number;
  color: [number, number, number];
}

export interface CrossBorderFlow {
  country: string; // 'DE', 'CH', etc.
  mw: number;      // positive = importing into Austria, negative = exporting
}

export interface GenerationData {
  fuels: FuelEntry[];
  crossBorder: CrossBorderFlow[];
}

// Shape of mock/mock_generation.json (and eventual live proxy response)
interface RawMix {
  generation_mw: Record<string, number>;
  pumped_storage_mw?: { generating?: number; pumping?: number };
  cross_border_mw?: Record<string, number>;
}

function parseMix(raw: RawMix): GenerationData {
  const totals: Record<string, number> = {};

  for (const [code, mw] of Object.entries(raw.generation_mw)) {
    const fuel = B_CODE[code] ?? "Other";
    totals[fuel] = (totals[fuel] ?? 0) + mw;
  }

  const psGen = raw.pumped_storage_mw?.generating ?? 0;
  if (psGen > 0)
    totals["Pumped Storage"] = (totals["Pumped Storage"] ?? 0) + psGen;

  const fuels = Object.entries(totals)
    .filter(([, mw]) => mw > 0)
    .map(([fuel, mw]) => ({
      fuel,
      mw,
      color: FUEL_COLORS[fuel] ?? FUEL_COLORS.Other,
    }))
    .sort((a, b) => b.mw - a.mw);

  const crossBorder = Object.entries(raw.cross_border_mw ?? {})
    .filter(([, mw]) => mw !== 0)
    .map(([country, mw]) => ({ country, mw }))
    .sort((a, b) => Math.abs(b.mw) - Math.abs(a.mw));

  return { fuels, crossBorder };
}

export async function fetchMix(url = "/api/generation"): Promise<GenerationData> {
  let res = await fetch(url);
  if (!res.ok && url !== "/mock/mock_generation.json") {
    console.warn(
      `fetchMix: live API returned ${res.status}, falling back to mock`,
    );
    res = await fetch("/mock/mock_generation.json");
  }
  if (!res.ok) throw new Error(`fetchMix: ${res.status} ${res.statusText}`);
  return parseMix((await res.json()) as RawMix);
}

/** Normalise entries to cumulative proportion thresholds [0..1]. */
export function toCumulativeWeights(
  entries: FuelEntry[],
): { color: [number, number, number]; threshold: number }[] {
  const total = entries.reduce((s, e) => s + e.mw, 0);
  if (total === 0) return [];

  let cumulative = 0;
  return entries.map((e) => {
    cumulative += e.mw / total;
    return { color: e.color, threshold: cumulative };
  });
}
