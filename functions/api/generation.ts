import type { KVNamespace } from '@cloudflare/workers-types'

interface Env {
  GENERATION_CACHE: KVNamespace
  ENTSOE_TOKEN: string
}

const CACHE_KEY = 'at_generation'
const CACHE_TTL_SECONDS = 15 * 60

export async function onRequest(context: { env: Env }): Promise<Response> {
  const { env } = context

  const cached = await env.GENERATION_CACHE.get(CACHE_KEY)
  if (cached) {
    return json(cached)
  }

  // TODO (Milestone 5): fetch ENTSO-E A75, parse XML → JSON, write to KV
  return json(JSON.stringify({ error: 'not implemented — use mock data' }), 501)
}

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
