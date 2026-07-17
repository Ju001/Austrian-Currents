#!/usr/bin/env node
// Usage: node scripts/get-generation.mjs [--raw]
//   --raw   dump the parsed JSON without the summary table

import { XMLParser } from 'fast-xml-parser'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const AT_EIC    = '10YAT-APG------L'
const ENTSOE_URL = 'https://web-api.tp.entsoe.eu/api'

const NEIGHBOR_EIC = {
  DE: '10Y1001A1001A83F',
  CH: '10YCH-SWISSGRIDZ',
  IT: '10YIT-GRTN-----B',
  SI: '10YSI-ELES-----O',
  HU: '10YHU-MAVIR----U',
  SK: '10YSK-SEPS-----K',
  CZ: '10YCZ-CEPS-----N',
}

const B_CODE = {
  B01: 'Biomass', B02: 'Lignite', B03: 'Coal Gas', B04: 'Gas',
  B05: 'Hard Coal', B06: 'Oil', B07: 'Oil Shale', B08: 'Peat',
  B09: 'Geothermal', B10: 'Pumped Storage', B11: 'Hydro', B12: 'Hydro',
  B13: 'Marine', B14: 'Nuclear', B15: 'Other Renewable', B16: 'Solar',
  B17: 'Waste', B18: 'Wind Offshore', B19: 'Wind', B20: 'Other', B25: 'Energy Storage',
}

function loadToken() {
  try {
    const env = readFileSync(resolve(import.meta.dirname, '../.dev.vars'), 'utf8')
    const match = env.match(/^ENTSOE_TOKEN=(.+)$/m)
    if (match) return match[1].trim()
  } catch { /* fall through */ }
  return process.env.ENTSOE_TOKEN
}

function entsoeDateTime(d) {
  return d.toISOString().replace(/[-T:]/g, '').slice(0, 12)
}

function toArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function latestPoint(ts) {
  const period = toArray(ts?.Period).at(-1)
  const points = toArray(period?.Point)
  const last   = points.at(-1)
  const mw     = Number(last?.quantity ?? 0)
  return { mw: isFinite(mw) ? mw : 0, position: Number(last?.position ?? 0) }
}

function parse(xml) {
  return new XMLParser({ ignoreAttributes: false }).parse(xml)
}

const token = loadToken()
if (!token) {
  console.error('No ENTSOE_TOKEN found in .dev.vars or environment')
  process.exit(1)
}

const now         = new Date()
const periodEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()))
const periodStart = new Date(periodEnd.getTime() - 2 * 60 * 60 * 1000)

// ── Fetch A75 generation ───────────────────────────────────────────────────────

const genRes = await fetch(`${ENTSOE_URL}?${new URLSearchParams({
  securityToken: token,
  documentType: 'A75',
  processType: 'A16',
  in_Domain: AT_EIC,
  periodStart: entsoeDateTime(periodStart),
  periodEnd: entsoeDateTime(periodEnd),
})}`)

if (!genRes.ok) {
  console.error(`ENTSO-E A75 error ${genRes.status}:`, await genRes.text())
  process.exit(1)
}

const doc = parse(await genRes.text())
const generation_mw = {}
let psGenerating = 0, psPumping = 0

for (const ts of toArray(doc?.GL_MarketDocument?.TimeSeries)) {
  const psr   = ts?.MktPSRType?.psrType ?? ''
  const isIn  = 'inBiddingZone_Domain.mRID'  in ts
  const isOut = 'outBiddingZone_Domain.mRID' in ts
  const { mw } = latestPoint(ts)
  if (!psr || mw <= 0) continue

  if (psr === 'B10') {
    if (isIn)  psGenerating += mw
    if (isOut) psPumping   += mw
  } else if (isIn) {
    generation_mw[psr] = (generation_mw[psr] ?? 0) + mw
  }
}

// ── Fetch A11 cross-border flows (all neighbors in parallel) ──────────────────

async function fetchFlow(inDomain, outDomain) {
  try {
    const res = await fetch(`${ENTSOE_URL}?${new URLSearchParams({
      securityToken: token,
      documentType: 'A11',
      in_Domain: inDomain,
      out_Domain: outDomain,
      periodStart: entsoeDateTime(periodStart),
      periodEnd: entsoeDateTime(periodEnd),
    })}`)
    if (!res.ok) return 0
    const d    = parse(await res.text())
    const root = d?.Publication_MarketDocument ?? d?.GL_MarketDocument ?? {}
    const tss  = toArray(root?.TimeSeries)
    return tss.length > 0 ? latestPoint(tss[0]).mw : 0
  } catch { return 0 }
}

const flowResults = await Promise.all(
  Object.entries(NEIGHBOR_EIC).flatMap(([country, eic]) => [
    fetchFlow(AT_EIC, eic).then(mw => ({ country, mw, dir: 'import' })),
    fetchFlow(eic, AT_EIC).then(mw => ({ country, mw, dir: 'export' })),
  ])
)

const cross_border_mw = {}
for (const { country, mw, dir } of flowResults) {
  cross_border_mw[country] = (cross_border_mw[country] ?? 0) + (dir === 'import' ? mw : -mw)
}

// ── Output ─────────────────────────────────────────────────────────────────────

const result = {
  timestamp: now.toISOString(),
  generation_mw,
  pumped_storage_mw: { generating: psGenerating, pumping: psPumping },
  cross_border_mw,
}

if (process.argv.includes('--raw')) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

// ── Pretty table ───────────────────────────────────────────────────────────────

const byFuel = {}
for (const [code, mw] of Object.entries(generation_mw)) {
  const fuel = B_CODE[code] ?? code
  byFuel[fuel] = (byFuel[fuel] ?? 0) + mw
}
const genRows = Object.entries(byFuel).map(([fuel, mw]) => ({ fuel, mw }))
if (psGenerating > 0) genRows.push({ fuel: 'Pumped Storage (gen)',  mw:  psGenerating })
if (psPumping   > 0) genRows.push({ fuel: 'Pumped Storage (pump)', mw: -psPumping })
genRows.sort((a, b) => b.mw - a.mw)

const total = genRows.filter(r => r.mw > 0).reduce((s, r) => s + r.mw, 0)
const w     = Math.max(...genRows.map(r => r.fuel.length))

console.log(`\nAustria generation  ${now.toUTCString()}`)
console.log('─'.repeat(w + 24))
for (const { fuel, mw } of genRows) {
  const bar  = '█'.repeat(Math.max(0, Math.round((Math.abs(mw) / total) * 20)))
  const sign = mw < 0 ? ' (consuming)' : ''
  console.log(`${fuel.padEnd(w)}  ${String(Math.abs(mw).toFixed(0)).padStart(6)} MW  ${bar}${sign}`)
}
console.log('─'.repeat(w + 24))
console.log(`${'Total'.padEnd(w)}  ${String(total.toFixed(0)).padStart(6)} MW`)

console.log(`\nCross-border flows`)
console.log('─'.repeat(28))
for (const [country, mw] of Object.entries(cross_border_mw).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
  const dir   = mw > 0 ? '◀ import' : '▶ export'
  console.log(`${country}  ${dir}  ${String(Math.abs(mw).toFixed(0)).padStart(6)} MW`)
}
