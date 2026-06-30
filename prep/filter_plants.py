#!/usr/bin/env python3
"""
Build public/plants.geojson for the Austrian Currents visualization.

Data sources (applied in this order):
  1. OpenStreetMap via Overpass API  — all power=plant + fuel-typed generators
  2. FWKWK_Kraftwerke_20210111.csv  — Austrian CHP register (biomass, gas, waste, oil)
     Entries within MERGE_RADIUS_M of an OSM plant are skipped (avoid double-counting).

Post-processing:
  • Wind turbines closer than WIND_CLUSTER_RADIUS_M are merged into one farm point
  • Plants/generators below MIN_CAPACITY_MW are dropped

Tune the constants below — no code changes needed.
"""

# ── CONFIGURATION ──────────────────────────────────────────────────────────────
MIN_CAPACITY_MW = 5.0          # MW  — drop anything below this (0 = keep all)
WIND_CLUSTER_RADIUS_M = 5000    # m   — merge nearby wind turbines into farm points
MERGE_RADIUS_M = 300           # m   — min distance for a CSV entry to be distinct from OSM
# ───────────────────────────────────────────────────────────────────────────────

import csv
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.join(SCRIPT_DIR, "../public/plants.geojson")
CSV_PATH = os.path.join(SCRIPT_DIR, "FWKWK_Kraftwerke_20210111.csv")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="AT"]->.austria;
(
  node["power"="plant"](area.austria);
  way["power"="plant"](area.austria);
  relation["power"="plant"](area.austria);
  node["power"="generator"]["generator:source"~"^(wind|solar|hydro|water|gas|natural_gas|biomass|biogas|biofuel|wood|waste|nuclear|coal|hard_coal|lignite|oil|diesel|geothermal|pumped_storage)$"](area.austria);
  way["power"="generator"]["generator:source"~"^(wind|solar|hydro|water|gas|natural_gas|biomass|biogas|biofuel|wood|waste|nuclear|coal|hard_coal|lignite|oil|diesel|geothermal|pumped_storage)$"](area.austria);
);
out center tags;
"""

FUEL_MAP: dict[str, str] = {
    "wind": "Wind",
    "solar": "Solar",
    "hydro": "Hydro",
    "water": "Hydro",
    "gas": "Gas",
    "natural_gas": "Gas",
    "biomass": "Biomass",
    "biogas": "Biomass",
    "biofuel": "Biomass",
    "wood": "Biomass",
    "waste": "Waste",
    "nuclear": "Nuclear",
    "coal": "Coal",
    "hard_coal": "Coal",
    "lignite": "Coal",
    "oil": "Oil",
    "diesel": "Oil",
    "geothermal": "Geothermal",
    "pumped_storage": "Pumped Storage",
}

CSV_FUEL_MAP: dict[str, str] = {
    "Biomasse": "Biomass",
    "Erdgas": "Gas",
    "Öl": "Oil",
    "Abfall": "Waste",
}


# ── Helpers ────────────────────────────────────────────────────────────────────

def parse_mw(val: str) -> tuple[float, bool]:
    """Return (capacity_mw, had_explicit_unit).  had_explicit_unit=False means the
    raw OSM tag had no unit suffix — caller should discard this entry."""
    val = re.sub(r"^[~≈<>]", "", val.strip()).upper()
    m = re.match(r"([\d.,]+)\s*(GW|MW|KW|W)?", val)
    if not m:
        return 0.0, False
    num = float(m.group(1).replace(",", "."))
    unit = m.group(2)
    mw = num * {"GW": 1000.0, "MW": 1.0, "KW": 0.001, "W": 1e-6}.get(unit or "MW", 1.0)
    return mw, unit is not None


def dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlat = (lat2 - lat1) * 111_000
    dlon = (lon2 - lon1) * 111_000 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.sqrt(dlat ** 2 + dlon ** 2)


def year_from_str(s: str) -> int | None:
    m = re.search(r"\b(1[89]\d{2}|20[012]\d)\b", s)
    return int(m.group(1)) if m else None


def make_feature(lon: float, lat: float, name: str, fuel: str, cap: float,
                 owner: str, year: int | None, osm_id: str,
                 is_plant: bool = True) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
        "properties": {
            "name": name,
            "fuel": fuel,
            "capacity_mw": round(cap, 2),
            "owner": owner,
            "commissioning_year": year,
            "osm_id": osm_id,
            "_is_plant": is_plant,  # stripped before writing
        },
    }


# ── OSM parsing ────────────────────────────────────────────────────────────────

def osm_coords(el: dict) -> tuple[float, float] | None:
    if el["type"] == "node":
        lat, lon = el.get("lat"), el.get("lon")
    else:
        c = el.get("center", {})
        lat, lon = c.get("lat"), c.get("lon")
    return (float(lat), float(lon)) if lat is not None and lon is not None else None


def osm_fuel(tags: dict, power: str) -> str:
    if power == "plant":
        source = tags.get("plant:source", tags.get("generator:source", ""))
        method = tags.get("plant:method", tags.get("plant:type", ""))
    else:
        source = tags.get("generator:source", "")
        method = tags.get("generator:method", "")
    if "pumped" in method.lower() or source.lower() == "pumped_storage":
        return "Pumped Storage"
    return FUEL_MAP.get(source.lower(), "Other")


def osm_cap(tags: dict, power: str) -> tuple[float, bool, str]:
    """Return (capacity_mw, had_explicit_unit, raw_tag_value).

    had_explicit_unit=False means the tag had a bare number with no unit.
    Caller should skip entries where this is True and cap > 0.
    """
    key = "plant:output:electricity" if power == "plant" else "generator:output:electricity"
    raw = tags.get(key, tags.get("generator:output:electricity", ""))
    if not raw:
        return 0.0, True, ""  # absent tag — no capacity info, not an ambiguous unit
    mw, had_unit = parse_mw(raw)
    return mw, had_unit, raw


# ── Wind clustering ────────────────────────────────────────────────────────────

def cluster_wind(features: list[dict], radius_m: float) -> list[dict]:
    """Merge individual wind-turbine generators into farm centroids."""
    turbines = [f for f in features
                if f["properties"]["fuel"] == "Wind" and not f["properties"]["_is_plant"]]
    rest = [f for f in features
            if not (f["properties"]["fuel"] == "Wind" and not f["properties"]["_is_plant"])]

    n = len(turbines)
    if n == 0:
        return features

    parent = list(range(n))

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    for i in range(n):
        lon_i = turbines[i]["geometry"]["coordinates"][0]
        lat_i = turbines[i]["geometry"]["coordinates"][1]
        for j in range(i + 1, n):
            lon_j = turbines[j]["geometry"]["coordinates"][0]
            lat_j = turbines[j]["geometry"]["coordinates"][1]
            # Quick bounding-box pre-filter before trig
            if abs(lat_j - lat_i) * 111_000 > radius_m:
                continue
            if dist_m(lat_i, lon_i, lat_j, lon_j) <= radius_m:
                pi, pj = find(i), find(j)
                if pi != pj:
                    parent[pi] = pj

    clusters: dict[int, list[dict]] = {}
    for i, t in enumerate(turbines):
        clusters.setdefault(find(i), []).append(t)

    aggregated: list[dict] = []
    for members in clusters.values():
        lons = [f["geometry"]["coordinates"][0] for f in members]
        lats = [f["geometry"]["coordinates"][1] for f in members]
        cap = sum(f["properties"]["capacity_mw"] for f in members)
        named = sorted(
            [f for f in members if f["properties"]["name"]],
            key=lambda f: -f["properties"]["capacity_mw"],
        )
        owner = next((f["properties"]["owner"] for f in members if f["properties"]["owner"]), "")
        aggregated.append(make_feature(
            lon=sum(lons) / len(lons),
            lat=sum(lats) / len(lats),
            name=named[0]["properties"]["name"] if named else "",
            fuel="Wind",
            cap=cap,
            owner=owner,
            year=None,
            osm_id=members[0]["properties"]["osm_id"],
            is_plant=True,
        ))

    print(f"  Wind: {n} turbines → {len(aggregated)} farm clusters")
    return rest + aggregated


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    # ── 1. OSM via Overpass ────────────────────────────────────────────────────
    print("Querying Overpass API for Austrian power plants…")
    data = urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=data, method="POST")
    req.add_header("User-Agent", "austria-currents-prep/1.0")
    try:
        with urllib.request.urlopen(req, timeout=200) as resp:
            payload = json.loads(resp.read())
    except urllib.error.URLError as exc:
        print(f"Overpass request failed: {exc}", file=sys.stderr)
        sys.exit(1)

    elements = payload.get("elements", [])
    print(f"  Raw elements: {len(elements)}")

    features: list[dict] = []
    positions: list[tuple[float, float]] = []  # (lat, lon) for dedup

    # (osm_id, name, fuel, raw_tag, parsed_mw) for entries with no unit suffix
    unit_warnings: list[tuple[str, str, str, str, float]] = []

    # Pass 1 — power=plant (take precedence)
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("power") != "plant":
            continue
        pos = osm_coords(el)
        if pos is None:
            continue
        lat, lon = pos
        osm_id = f"{el['type']}/{el['id']}"
        name = tags.get("name", "").strip()
        fuel = osm_fuel(tags, "plant")
        cap, had_unit, raw_tag = osm_cap(tags, "plant")
        if not had_unit and cap > 0:
            unit_warnings.append((osm_id, name, fuel, raw_tag, cap))
            continue
        features.append(make_feature(
            lon=lon, lat=lat,
            name=name,
            fuel=fuel,
            cap=cap,
            owner=tags.get("operator", tags.get("owner", "")).strip(),
            year=year_from_str(tags.get("start_date", "")),
            osm_id=osm_id,
            is_plant=True,
        ))
        positions.append((lat, lon))

    print(f"  OSM power=plant: {len(features)}")

    # Pass 2 — standalone generators (skip if within 200 m of a plant)
    gen_added = 0
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("power") != "generator":
            continue
        pos = osm_coords(el)
        if pos is None:
            continue
        lat, lon = pos
        if any(dist_m(lat, lon, plat, plon) < 200 for plat, plon in positions):
            continue
        osm_id = f"{el['type']}/{el['id']}"
        name = tags.get("name", "").strip()
        fuel = osm_fuel(tags, "generator")
        cap, had_unit, raw_tag = osm_cap(tags, "generator")
        if not had_unit and cap > 0:
            unit_warnings.append((osm_id, name, fuel, raw_tag, cap))
            continue
        features.append(make_feature(
            lon=lon, lat=lat,
            name=name,
            fuel=fuel,
            cap=cap,
            owner=tags.get("operator", tags.get("owner", "")).strip(),
            year=year_from_str(tags.get("start_date", "")),
            osm_id=osm_id,
            is_plant=False,
        ))
        positions.append((lat, lon))
        gen_added += 1

    print(f"  OSM generators (standalone): {gen_added}")

    # ── 2. CSV supplement ──────────────────────────────────────────────────────
    csv_added = 0
    if os.path.exists(CSV_PATH):
        print(f"  Merging {os.path.basename(CSV_PATH)}…")
        with open(CSV_PATH, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                try:
                    lon = float(row["Laengengrad"].replace(",", "."))
                    lat = float(row["Breitengrad"].replace(",", "."))
                    cap = float(row["P_Nenn_el"].replace(",", "."))
                except (ValueError, KeyError):
                    continue
                if any(dist_m(lat, lon, plat, plon) < MERGE_RADIUS_M for plat, plon in positions):
                    continue
                fuel = CSV_FUEL_MAP.get(row.get("Brennstoff", ""), "Other")
                features.append(make_feature(
                    lon=lon, lat=lat,
                    name=row.get("Kraftwerk", "").strip(),
                    fuel=fuel,
                    cap=cap,
                    owner=row.get("Betreiber", "").strip(),
                    year=None,
                    osm_id="csv/fwkwk",
                    is_plant=True,
                ))
                positions.append((lat, lon))
                csv_added += 1
        print(f"  CSV entries added: {csv_added}")
    else:
        print(f"  (CSV not found at {CSV_PATH}, skipping)")

    # ── 3. Cluster wind turbines ───────────────────────────────────────────────
    features = cluster_wind(features, WIND_CLUSTER_RADIUS_M)

    # ── 4. Capacity filter ─────────────────────────────────────────────────────
    before = len(features)
    if MIN_CAPACITY_MW > 0:
        features = [f for f in features if f["properties"]["capacity_mw"] >= MIN_CAPACITY_MW]
    print(f"  Capacity filter ≥ {MIN_CAPACITY_MW} MW: {before} → {len(features)}")

    # ── Unit warnings ──────────────────────────────────────────────────────────────
    if unit_warnings:
        print(f"\n  ⚠  {len(unit_warnings)} plant(s) excluded — capacity tag has no unit (fix on openstreetmap.org)")
        print(f"     {'OSM ID':<30} {'Fuel':<16} {'Raw tag':<12}  Name")
        for oid, name, fuel, raw, _ in sorted(unit_warnings, key=lambda x: x[0]):
            print(f"     {oid:<30} {fuel:<16} {raw:<12}  {name or '(unnamed)'}")

    # ── 5. Strip internal flags ────────────────────────────────────────────────
    for feat in features:
        feat["properties"].pop("_is_plant", None)

    # ── 6. Write output ────────────────────────────────────────────────────────
    fuel_counts: dict[str, int] = {}
    for feat in features:
        k = feat["properties"]["fuel"]
        fuel_counts[k] = fuel_counts.get(k, 0) + 1

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)

    print(f"\nWrote {len(features)} plants → {OUT_PATH}")
    print("Fuel breakdown:")
    for fuel, count in sorted(fuel_counts.items(), key=lambda x: -x[1]):
        print(f"  {fuel:<22} {count}")


if __name__ == "__main__":
    main()
