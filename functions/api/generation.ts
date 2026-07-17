import { XMLParser } from 'fast-xml-parser'
import type { KVNamespace } from '@cloudflare/workers-types'

interface Env {
  ENTSOE_TOKEN: string
  GENERATION_CACHE: KVNamespace
}

interface PagesContext {
  env: Env
  waitUntil: (p: Promise<unknown>) => void
}

const AT_EIC    = '10YAT-APG------L'
const ENTSOE_URL = 'https://web-api.tp.entsoe.eu/api'
const CACHE_KEY  = 'at_generation_v2'   // bump when response shape changes
const CACHE_TTL  = 15 * 60             // seconds KV keeps the entry
const REFRESH_AFTER = 13 * 60          // background-refresh window

const NEIGHBOR_EIC: Record<string, string> = {
  DE: '10Y1001A1001A83F',
  CH: '10YCH-SWISSGRIDZ',
  IT: '10YIT-GRTN-----B',
  SI: '10YSI-ELES-----O',
  HU: '10YHU-MAVIR----U',
  SK: '10YSK-SEPS-----K',
  CZ: '10YCZ-CEPS-----N',
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { env } = context

  const cached = await env.GENERATION_CACHE.get(CACHE_KEY)
  if (cached) {
    try {
      const age = (Date.now() - new Date(JSON.parse(cached).timestamp).getTime()) / 1000
      if (age > REFRESH_AFTER) context.waitUntil(fetchAndCache(env))
    } catch { /* return stale if parse fails */ }
    return json(cached)
  }

  try {
    return json(await fetchAndCache(env))
  } catch (e) {
    return err(String(e), 502)
  }
}

// ── Main fetch ────────────────────────────────────────────────────────────────

async function fetchAndCache(env: Env): Promise<string> {
  const token = env.ENTSOE_TOKEN
  if (!token) throw new Error('ENTSOE_TOKEN not configured')

  const now         = new Date()
  const periodEnd   = truncateToHour(now)
  const periodStart = new Date(periodEnd.getTime() - 2 * 60 * 60 * 1000)

  // Generation (A75) + all cross-border directions (A11) in one parallel batch
  const [gen, ...flows] = await Promise.all([
    fetchGeneration(token, periodStart, periodEnd),
    ...Object.entries(NEIGHBOR_EIC).flatMap(([country, eic]) => [
      fetchFlow(token, AT_EIC, eic, periodStart, periodEnd)
        .then(mw => ({ country, mw, dir: 'import' as const })),
      fetchFlow(token, eic, AT_EIC, periodStart, periodEnd)
        .then(mw => ({ country, mw, dir: 'export' as const })),
    ]),
  ])

  // positive = importing into AT, negative = exporting from AT
  const cross_border_mw: Record<string, number> = {}
  for (const { country, mw, dir } of flows) {
    cross_border_mw[country] =
      (cross_border_mw[country] ?? 0) + (dir === 'import' ? mw : -mw)
  }

  const body = JSON.stringify({
    timestamp: now.toISOString(),
    ...gen,
    cross_border_mw,
  })

  await env.GENERATION_CACHE.put(CACHE_KEY, body, { expirationTtl: CACHE_TTL })
  return body
}

// ── ENTSO-E fetchers ──────────────────────────────────────────────────────────

async function fetchGeneration(
  token: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<{
  generation_mw: Record<string, number>
  pumped_storage_mw: { generating: number; pumping: number }
}> {
  const params = new URLSearchParams({
    securityToken: token,
    documentType: 'A75',
    processType: 'A16',
    in_Domain: AT_EIC,
    periodStart: entsoeDateTime(periodStart),
    periodEnd: entsoeDateTime(periodEnd),
  })

  const res = await fetch(`${ENTSOE_URL}?${params}`)
  if (!res.ok) throw new Error(`ENTSO-E A75 ${res.status}: ${await res.text()}`)
  const doc = parse(await res.text())

  const generation_mw: Record<string, number> = {}
  let psGenerating = 0
  let psPumping    = 0

  for (const ts of toArray(doc?.GL_MarketDocument?.TimeSeries)) {
    const psr: string = ts?.MktPSRType?.psrType ?? ''
    if (!psr) continue

    const isIn  = 'inBiddingZone_Domain.mRID'  in ts
    const isOut = 'outBiddingZone_Domain.mRID' in ts
    const { mw } = latestPoint(ts)
    if (mw <= 0) continue

    if (psr === 'B10') {
      if (isIn)  psGenerating += mw
      if (isOut) psPumping   += mw
    } else if (isIn) {
      generation_mw[psr] = (generation_mw[psr] ?? 0) + mw
    }
  }

  return { generation_mw, pumped_storage_mw: { generating: psGenerating, pumping: psPumping } }
}

/** Returns the latest MW value for a single A11 Physical Flows series. Returns 0 on any error. */
async function fetchFlow(
  token: string,
  inDomain: string,
  outDomain: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<number> {
  const params = new URLSearchParams({
    securityToken: token,
    documentType: 'A11',
    in_Domain: inDomain,
    out_Domain: outDomain,
    periodStart: entsoeDateTime(periodStart),
    periodEnd: entsoeDateTime(periodEnd),
  })

  try {
    const res = await fetch(`${ENTSOE_URL}?${params}`)
    if (!res.ok) return 0

    const doc  = parse(await res.text())
    const root = doc?.Publication_MarketDocument ?? doc?.GL_MarketDocument ?? {}
    const tss  = toArray(root?.TimeSeries)
    if (tss.length === 0) return 0

    return latestPoint(tss[0]).mw
  } catch {
    return 0
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parse(xml: string): Record<string, unknown> {
  return new XMLParser({ ignoreAttributes: false }).parse(xml) as Record<string, unknown>
}

function latestPoint(ts: Record<string, unknown>): { mw: number; position: number } {
  const period   = toArray(ts?.Period).at(-1) as Record<string, unknown> | undefined
  const points   = toArray(period?.Point)
  const last     = points.at(-1) as Record<string, unknown> | undefined
  const mw       = Number(last?.quantity ?? 0)
  const position = Number(last?.position ?? 0)
  return { mw: isFinite(mw) ? mw : 0, position }
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function entsoeDateTime(d: Date): string {
  return d.toISOString().replace(/[-T:]/g, '').slice(0, 12)
}

function truncateToHour(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()))
}

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function err(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
