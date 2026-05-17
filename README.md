# Abundance Farm

Rice and corn operations app for **MAK-CT** in San Isidro West, Santa Maria, Isabela.

Live at **[abundance.mak-ct.com](https://abundance.mak-ct.com)** — installable as a phone app (iOS Safari → *Add to Home Screen*, Android Chrome → *Install app*).

## What it does

Twelve tabs covering daily farm life: Today, Calendar, Dashboard, Areas, Crops, Prices, Weather, Tasks, Accounting, Equipment, Inventory, and Breeds. Highlights:

- **Live weather** for the farm coordinates (16.8167, 121.7167) via Open-Meteo
- **Daily palay & corn price intel** scraped from PSA OpenSTAT + Google Sheet override, with seasonal sell/hold/avoid guidance and NFA buying-price reference
- **Per-area operations tracking** — areas, crops, tasks, inventory, harvests, labor, equipment, fuel logs, accounting
- **Typhoon risk awareness** tuned to Cagayan Valley history
- **Multi-user auth** via Cloudflare-managed `ADMIN_SECRET`; Owner can invite Farm Managers
- **Offline-friendly** PWA; data persists to localStorage and syncs to the Worker

## Stack

A single Cloudflare Worker named **`abundance-prices`** serves both the app and the API from one origin:

- **Static assets** — `public/index.html` (React + Recharts + Babel from CDN, no build step)
- **API** — `src/index.js` (auth, users, prices, weather proxy, NDVI imagery, photo diagnosis)
- **Storage** — KV namespace `PRICES` for users, sessions, prices, areas, and operations data
- **Scheduled** — Daily 22:00 UTC cron pulls PSA OpenSTAT + Google Sheet for fresh prices
- **Custom domain** — `abundance.mak-ct.com` routed via Cloudflare dashboard

## Quick deploy

From this folder:

```bash
npm run deploy
```

That single command installs deps, runs smoke tests, generates/uploads `ADMIN_SECRET` on first run, deploys the Worker, and pings `/api/health` to confirm. For the full step-by-step (including first-time setup, custom domain attachment, and troubleshooting), see [DEPLOY.md](./DEPLOY.md).

One-click `.command` shortcuts in this folder for routine ops: `redeploy.command`, `redeploy-and-open.command`, `setup-secrets.command`, `reset-and-bootstrap.command`.

## Local development

```bash
npx wrangler dev    # http://localhost:8787
npm test            # offline smoke test of auth + role logic
```

## Repository

Private repo: `github.com/Phelicskit/abundance-farm`. Local clone is the deployable working tree — edits go via `git commit` + `git push`, then `npm run deploy`.
