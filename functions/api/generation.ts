import { XMLParser } from 'fast-xml-parser'

interface Env {
  ENTSOE_TOKEN: string
}

const AT_EIC = '10YAT-APG------L'
const ENTSOE_URL = 'https://web-api.tp.entsoe.eu/api'


export async function onRequest(context: { env: Env }): Promise<Response> {
  const token = context.env.ENTSOE_TOKEN
  if (!token) return err('ENTSOE_TOKEN not configured', 500)

  // Request a 2-hour window ending now to guarantee at least one settled interval
  const now = new Date()
  const periodEnd = truncateToHour(now)
  const periodStart = new Date(periodEnd.getTime() - 2 * 60 * 60 * 1000)

  const params = new URLSearchParams({
    securityToken: token,
    documentType: 'A75',
    processType: 'A16',
    in_Domain: AT_EIC,
    periodStart: entsoeDateTime(periodStart),
    periodEnd: entsoeDateTime(periodEnd),
  })

  let xmlText: string
  try {
    const res = await fetch(`${ENTSOE_URL}?${params}`)
    if (!res.ok) return err(`ENTSO-E ${res.status}: ${await res.text()}`, 502)
    xmlText = await res.text()
  } catch (e) {
    return err(String(e), 502)
  }

  const parser = new XMLParser({ ignoreAttributes: false })
  const doc = parser.parse(xmlText)

  const generation_mw: Record<string, number> = {}
  let psGenerating = 0
  let psPumping = 0

  for (const ts of toArray(doc?.GL_MarketDocument?.TimeSeries)) {
    const psr: string = ts?.MktPSRType?.psrType ?? ''
    if (!psr) continue

    // inBiddingZone = generation flowing into the zone (producing)
    // outBiddingZone = consumption flowing out (pumped storage charging)
    const isIn = 'inBiddingZone_Domain.mRID' in ts
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

  return json({
    timestamp: now.toISOString(),
    generation_mw,
    pumped_storage_mw: { generating: psGenerating, pumping: psPumping },
  })
}

// ── helpers ────────────────────────────────────────────────────────────────────

function latestPoint(ts: Record<string, unknown>): { mw: number; position: number } {
  const period = toArray(ts?.Period).at(-1) as Record<string, unknown> | undefined
  const points = toArray(period?.Point)
  const last   = points.at(-1) as Record<string, unknown> | undefined
  const mw     = Number(last?.quantity ?? 0)
  const position = Number(last?.position ?? 0)
  return { mw: isFinite(mw) ? mw : 0, position }
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

/** ENTSO-E datetime format: YYYYMMDDHHmm (UTC) */
function entsoeDateTime(d: Date): string {
  return d.toISOString().replace(/[-T:]/g, '').slice(0, 12)
}

/** Truncate to the start of the current UTC hour */
function truncateToHour(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()))
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function err(message: string, status: number): Response {
  return json({ error: message }, status)
}
