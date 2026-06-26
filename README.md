# Austria-Currents

A live, geographic visualization of Austria's electricity grid — real power plants on a dark MapLibre map, particles flowing from generation through the real high-voltage transmission network toward demand centers. Flow rates are driven by Austria's live ENTSO-E generation mix. Pumped storage is bidirectional (particles flow *into* storage when charging, *out* when generating). This is **data art over real infrastructure**, not a metered dashboard — per-plant output and per-line flow are modeled via capacity-weighted disaggregation, not measured.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is enough)
- An [ENTSO-E API token](https://transparency.entsoe.eu/usrm/user/myAccountSettings) (free registration)

---

## Local development

### Frontend only (mock data)

The frontend can run fully offline using `mock/mock_generation.json` — no Cloudflare or ENTSO-E token needed.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

### Full stack (frontend + Cloudflare Pages Functions)

This wires up the local Vite dev server to a local Wrangler Pages environment so the `/api/generation` function runs alongside the frontend.

```bash
npm run dev:full
```

Wrangler proxies `http://localhost:8788` → Vite on `:5173`. The Pages Function still returns a stub (`not implemented — use mock data`) until Milestone 5 is complete.

---

## Cloudflare setup

### 1. Log in

```bash
wrangler login
```

In a dev container or remote environment where `wrangler login` times out waiting for a browser, bind the callback to a forwarded port instead:

```bash
wrangler login --browser=false --callback-host=0.0.0.0 --callback-port=8976 | stdbuf -oL sed 's/0\.0\.0\.0/localhost/g'
```

This prints the OAuth URL with `localhost:8976` so you can open it directly in your local browser. Make sure port `8976` is forwarded from the container.

### 2. Create a KV namespace

The proxy caches ENTSO-E responses in Workers KV to stay within rate limits and avoid redundant fetches.

```bash
wrangler kv namespace create GENERATION_CACHE
wrangler kv namespace create GENERATION_CACHE --preview
```

Each command prints an `id`. Copy `wrangler.toml.example` to `wrangler.toml` (gitignored) and fill in the IDs:

```toml
[[kv_namespaces]]
binding = "GENERATION_CACHE"
id = "YOUR_PRODUCTION_KV_ID"
preview_id = "YOUR_PREVIEW_KV_ID"
```

### 3. Store the ENTSO-E token as a secret

```bash
wrangler pages secret put ENTSOE_TOKEN
# paste your token when prompted
```

For local development the secret is only needed once Milestone 5 is implemented. You can skip this step until then.

### 4. Create the Pages project (first deploy only)

```bash
wrangler pages project create austrian-currents
```

---

## Deployment

```bash
npm run deploy
```

This runs `tsc && vite build` then `wrangler pages deploy dist`. Wrangler uploads the built assets and the `functions/` directory to Cloudflare Pages.

The live URL is printed at the end of the deploy output. By default it follows the pattern `https://austrian-currents.pages.dev`.

---

## Project structure

```
functions/
  api/
    generation.ts   # Cloudflare Pages Function — ENTSO-E proxy with KV cache
mock/
  mock_generation.json  # offline stand-in for the live API response
src/
  main.ts           # MapLibre + deck.gl setup
prep/               # (future) Python scripts for data preparation
```

---

## Data sources

| Layer | Source | License |
|---|---|---|
| Plant locations + capacity | WRI Global Power Plant Database | CC-BY-4.0 |
| HV grid (lines, substations) | PyPSA-Eur OSM extract (Zenodo) | ODbL |
| Live generation by fuel | ENTSO-E A75 (`actualGenerationPerProductionType`) | free token |
| Cross-border flows | ENTSO-E physical flows | free token |
| Hydro reservoir levels | APG Transparency (`markt.apg.at`) | CC BY |

---

## Real vs. modeled

Per-plant output and per-line flow are **modeled estimates**, not measurements. National per-fuel totals from ENTSO-E are disaggregated to individual plants via capacity-weighted proportional allocation. The visual is data art — treat it as such.