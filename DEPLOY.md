# Abundance Farm — deploy guide

One Cloudflare Worker serves both the app (HTML/JS) and the API. One folder, one deploy command.

## What you need (one-time)

- A Cloudflare account already logged in via Wrangler (`npx wrangler login`)
- A KV namespace (already created — `id 91904ff4515a4c799b782b83e9111a45`, kept in `wrangler.toml`)
- Node 18+ and npm

## Deploy with one command

From this folder (`abundance-farm/`):

```bash
npm run deploy
```

That single command:

1. Checks Node and openssl are installed
2. Installs npm dependencies if missing
3. Runs the offline smoke test (17 checks of auth + role logic)
4. Verifies you are logged in to Cloudflare (and runs `wrangler login` if you are not)
5. Generates a strong `ADMIN_SECRET` and uploads it on first deploy — copy what it prints, you will paste it once into the app
6. Runs `wrangler deploy`
7. Pings `/api/health` to confirm the Worker is reachable

Run it again any time after editing code. On subsequent runs it skips secret generation (use `npm run deploy:rotate-secret` to force a new one).

To preview the steps without actually deploying:

```bash
npm run deploy:dry
```

This *upgrades the existing `abundance-prices` Worker* in place — same KV, same cron, same secrets. The terminal prints `https://abundance-prices.fktaguba.workers.dev` — that URL now serves the full app, not just the API.

## Attach your custom domain

To use `abundance.mak-ct.com`:

1. Cloudflare dashboard → **Workers and Pages**
2. Click **abundance-prices**
3. **Settings** → **Domains and Routes** → **Add** → **Custom Domain**
4. Domain: `abundance.mak-ct.com`
5. Click **Add Domain**

Cloudflare creates the DNS record automatically (since the domain is on your account). Wait 30 seconds, then visit `https://abundance.mak-ct.com`.

## First-time login

The app shows a **First-time setup** screen because no users exist yet. Fill in:

- Your email
- Display name (optional)
- A password (8+ characters)
- The `ADMIN_SECRET` you generated above

That creates the Owner account and signs you in. From then on, **Prices tab → Users · Owner-only** lets you add Farm Managers.

## Verify it works

```bash
curl -s https://abundance.mak-ct.com/api/health
```

Expected: `{"ok":true,"now":"2026-..."}`

## Updating later

Edit `src/index.js` (the API) or `public/index.html` (the app), then:

```bash
npx wrangler deploy
```

That is the entire update flow.

## Useful commands

```bash
npx wrangler tail                         # live logs from the deployed Worker
npx wrangler secret list                  # which secrets are set
npx wrangler kv key list --binding PRICES # what is in KV
npx wrangler dev                          # run locally on http://localhost:8787
npm test                                  # offline smoke test of the auth + role logic
```

## If you get stuck

**"First-time setup" doesn't appear and login fails — but you don't remember any password.**
A user already exists in KV from an earlier attempt. Wipe it, then re-bootstrap:

```bash
npx wrangler kv key delete --binding PRICES users
```

Refresh the app — first-time setup will appear again.

**"unauthorized" when bootstrapping the first owner.**
The `ADMIN_SECRET` you typed in the app does not match the one stored on the Worker. Re-set the secret with `openssl rand -hex 32 | npx wrangler secret put ADMIN_SECRET`, copy the printed value, paste it again on the setup screen.

**Logs API works but the page shows "Worker not reachable".**
The custom domain isn't attached yet. Either visit the `*.workers.dev` URL directly, or finish the Add Custom Domain step above.

## Clean up old leftovers (when you are sure the new Worker works)

Two things you can safely remove from the Cloudflare dashboard once the new setup is verified:

1. **Pages project `abundance-farm`** — Workers and Pages → click it → Settings → Delete project. The Worker has a different name (`abundance-prices`) and is unaffected.
2. **Old folders on disk** (optional) — `abundance-prices-worker/` and `abundance-farm-site/` are now superseded by `abundance-farm/`. Keep them as a backup, or delete after a week of confirmed uptime.
