# Abundance Farm

Single-file web app for **MAK-CT rice and corn operations** in San Isidro West, Santa Maria, Isabela.

Twelve tabs — Today, Calendar, Dashboard, Areas, Crops, Prices, Weather, Tasks, Accounting, Equipment, Inventory, Breeds — with live Open-Meteo weather for the farm coordinates (16.8167, 121.7167), seasonal palay/corn price guidance, monthly task checklists, and full operations tracking (areas, tasks, inventory, harvests, labor, equipment, fuel, accounting). All data persists to the browser's localStorage.

No build step. `index.html` loads React, Recharts, and Babel from CDN and runs the app client-side.

## Deploy to GitHub Pages

1. Create an empty public repo on GitHub (e.g. `abundance-farm`).
2. From this folder, run:

   ```bash
   git remote add origin https://github.com/<your-username>/<repo>.git
   git branch -M main
   git push -u origin main
   ```
3. In the repo on GitHub: **Settings → Pages**. Set *Source* to "Deploy from a branch", *Branch* to `main` / `(root)`, then **Save**.
4. Wait ~30 seconds. Your URL is `https://<your-username>.github.io/<repo>/`.

Every subsequent `git push` re-deploys automatically.

## Install as a phone app

Open the deployed URL on your phone:

- **iPhone (Safari)** — Share → *Add to Home Screen*
- **Android (Chrome)** — three-dot menu → *Install app*

The PWA meta tags are already set: full-screen launch, dark green theme, golden "A" icon.

## Local preview

Just double-click `index.html` — works from `file://` too, as long as your browser can reach the CDNs.

## Update the app

Edit `index.html` locally (the app code is in the final `<script type="text/plain" id="app-source">` block), then:

```bash
git add index.html
git commit -m "Update app"
git push
```

## Farm context

- Location: Santa Maria, Isabela (16.8167, 121.7167) — weather auto-fetched
- Crops: Rice (dry + wet season) and yellow corn (1st + 2nd crop, rainfed)
- Price intel: Seasonal palay and corn price curves with sell/hold/avoid guidance
- Typhoon risk tracking tied to Cagayan Valley history (Ompong, Ulysses, Kristine, etc.)
