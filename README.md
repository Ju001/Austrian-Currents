# Austrian Currents

**[austrian-currents.pages.dev](https://austrian-currents.pages.dev)** — a live WebGL visualization of Austria's electricity grid.

Real power generation data from ENTSO-E flows as animated fluid across a dark map of Austria. The color of the fluid reflects the live fuel mix: deep blue for hydro, gold for solar, cyan for wind, orange for gas. Cross-border imports and exports appear as particle streams entering or leaving the country at each interconnection point.

![screenshot placeholder](docs/screenshot.png)

---

## What it shows

| Element | What it represents |
|---|---|
| Fluid color & intensity | Live generation mix (hydro, wind, solar, gas, …) |
| Fluid motion | Stylized flow from generation toward demand |
| Border particle streams | Physical cross-border flows — direction shows import vs. export |
| MW panel (bottom right) | Live cross-border magnitudes per neighbor country |
| Fuel mix panel (top right) | Per-fuel share of total generation |

Data refreshes every 15 minutes from the [ENTSO-E Transparency Platform](https://transparency.entsoe.eu/).

---

## How it works

Three layers built on top of each other:

**Fluid simulation** — a Navier-Stokes solver running on WebGL 2 inside a MapLibre custom layer. Each active fuel type injects dye of its color; vorticity confinement and a gentle background gyre keep the flow interesting. The fluid is confined to Austria's border via a signed-distance field mask.

**Cross-border overlay** — a Canvas 2D layer draws Bézier particle streams from each neighbor country to Austria's border crossings. Particle direction is inverted for imports vs. exports.

**Serverless proxy** — a Cloudflare Pages Function polls ENTSO-E every 15 minutes, parses the XML response, and caches clean JSON in Workers KV. The browser never touches the ENTSO-E API directly.

---

## Data sources

| Data | Source | Notes |
|---|---|---|
| Live generation by fuel | [ENTSO-E A75](https://transparency.entsoe.eu/) | 15-min resolution, free token |
| Cross-border physical flows | [ENTSO-E A11](https://transparency.entsoe.eu/) | per border, 7 neighbors |

Per-plant output and per-line flow are **modeled estimates**, not measurements. National per-fuel totals are disaggregated to individual plants via capacity-weighted proportional allocation. The visualization is data art — not an operational dashboard.

---

## Tech stack

- [MapLibre GL JS](https://maplibre.org/) — dark basemap, custom WebGL layer
- [Cloudflare Pages](https://pages.cloudflare.com/) + Pages Functions — hosting and ENTSO-E proxy
- [Vite](https://vitejs.dev/) + TypeScript — build tooling
- [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) — ENTSO-E XML parsing in the Worker

---

## Running locally

```bash
npm install
npm run dev      # frontend only, mock data, no token needed
```

Open `http://localhost:5173`. The dev mode uses `public/mock/mock_generation.json` and exposes sliders to adjust the fuel mix without polling the live API.

See [DEPLOYMENT.md](DEPLOYMENT.md) for Cloudflare setup and production deployment.

---

## License

MIT — see [LICENSE](LICENSE).

ENTSO-E data is used under their [terms of use](https://transparency.entsoe.eu/terms-and-conditions) (free, registration required).
