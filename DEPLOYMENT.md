# Deployment

The app is deployed to **[austrian-currents.pages.dev](https://austrian-currents.pages.dev)** via Cloudflare Pages.

## Prerequisites

- Node.js 20+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier)
- An [ENTSO-E API token](https://transparency.entsoe.eu/usrm/user/myAccountSettings) (free registration)

## First-time Cloudflare setup

### 1. Log in to Wrangler

```bash
wrangler login
```

In a dev container where the browser callback can't reach `localhost`, forward port 8976 and use:

```bash
wrangler login --browser=false --callback-host=0.0.0.0 --callback-port=8976 \
  | stdbuf -oL sed 's/0\.0\.0\.0/localhost/g'
```

### 2. Create the KV namespace

```bash
wrangler kv namespace create GENERATION_CACHE
wrangler kv namespace create GENERATION_CACHE --preview
```

Copy the printed IDs into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding     = "GENERATION_CACHE"
id          = "YOUR_PRODUCTION_KV_ID"
preview_id  = "YOUR_PREVIEW_KV_ID"
```

### 3. Store the ENTSO-E token

```bash
wrangler pages secret put ENTSOE_TOKEN
# paste your token when prompted
```

For local development, put the token in `.dev.vars` (gitignored):

```
ENTSOE_TOKEN=your-token-here
```

### 4. Create the Pages project (once)

```bash
wrangler pages project create austrian-currents
```

## Deploy

```bash
npm run deploy
# expands to: tsc && vite build && wrangler pages deploy dist
```

The Pages Function in `functions/api/generation.ts` is deployed alongside the static assets automatically.

## Local full-stack development

```bash
npm run dev:full
```

Runs Vite on `:5173` and Wrangler Pages dev on `:8788`. The Wrangler proxy wires the two together and serves `/api/generation` from the local Pages Function with `.dev.vars` secrets injected.

## Debugging the ENTSO-E feed

```bash
node scripts/get-generation.mjs        # pretty table
node scripts/get-generation.mjs --raw  # raw JSON
```

Reads the token from `.dev.vars` or `$ENTSOE_TOKEN`. Fetches A75 generation and A11 cross-border flows directly and prints a summary — useful for checking what the API is currently returning without a full deploy.

## Caching

The Pages Function caches ENTSO-E responses in Workers KV for 15 minutes (`CACHE_TTL = 900 s`). A background refresh is triggered when the cached entry is older than 13 minutes, so cold requests are rare. To force a fresh fetch, delete the KV entry:

```bash
wrangler kv key delete --binding GENERATION_CACHE at_generation_v2
```
