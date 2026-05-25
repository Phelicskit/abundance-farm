// ============================================================
// Abundance Farm Prices — Cloudflare Worker
// ============================================================
// Scrapes or fetches Philippine palay + corn prices once a day,
// caches in KV, and serves JSON at /api/prices.json.
//
// Routes (once deployed at abundance.mak-ct.com/api/*):
//   GET  /api/prices.json              → latest cached data + metadata
//   GET  /api/prices.json?refresh=1    → force re-scrape now (rate-limited)
//   POST /api/refresh                  → manual re-scrape (requires ADMIN_SECRET header)
//
//   POST /api/login                    → {email,password} → {token, user}
//   POST /api/logout                   → invalidate current session token
//   GET  /api/me                       → current user from Authorization: Bearer <token>
//   POST /api/password                 → change own password
//
//   GET    /api/users                  → list users (Owner)
//   POST   /api/users                  → create user (Owner; first owner via X-Admin-Secret)
//   PUT    /api/users/:email           → update name/role/password (Owner)
//   DELETE /api/users/:email           → delete user (Owner; cannot delete self)
//
//   GET    /api/log                    → public read of price log
//   POST   /api/log                    → append a logged price (any signed-in user)
//   DELETE /api/log/:id                → delete entry  (Owner = any; Manager = own only)
//   PUT    /api/log/:id                → update entry  (Owner = any; Manager = own only)
//
//   GET    /api/ops                    → operational data blob (areas, harvest, equipment, ...)
//   PATCH  /api/ops                    → merge patch into the blob (signed-in user)
//   PUT    /api/ops                    → full-replace the blob (Owner only — used for restore)
//
//   POST   /api/diagnose               → Claude vision crop diagnosis (signed-in user)
//                                         body: { image: base64DataURL, areaName, cropType, notes }
//                                         requires ANTHROPIC_API_KEY secret
//
//   GET    /api/maps-config             → { googleMapsApiKey | null }
//                                          requires GOOGLE_MAPS_API_KEY secret
//
//   GET    /api/ndvi-tile?z&x&y        → Sentinel-2 NDVI tile (Mercator XYZ)
//   GET    /api/ndvi-tile?probe=1      → check if NDVI is configured
//   GET    /api/ndvi-info?lat&lon      → date + cloud cover of the most recent
//                                         Sentinel-2 image covering that point
//                                         requires SENTINEL_HUB_INSTANCE_ID secret
//
// Cron (see wrangler.toml): "0 22 * * *" = 06:00 Asia/Manila daily
//
// Source modes (set via env var SOURCE_MODE):
//   "sheet"  — fetch a Google Sheet CSV (set GOOGLE_SHEET_CSV_URL). Most reliable.
//   "philrice" — scrape https://www.philrice.gov.ph/price-watch/ (best-effort HTML parsing)
//   "custom" — fetch CUSTOM_SOURCE_URL, parse as CSV with columns:
//              date,palayFresh,palayDry,cornFresh,cornDry
//
// KV binding: PRICES (namespace id set in wrangler.toml)
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret, X-Log-Secret, Authorization',
  'Access-Control-Max-Age': '86400',
};

const KV_KEY = 'latest';
const KV_LOG_KEY = 'logged';                       // user-entered price log (synced)
const KV_USERS_KEY = 'users';                      // map of {email: userRecord}
const KV_OPS_KEY = 'ops';                          // operational data blob (areas, harvest, equipment, ...)
const KV_NFA_FLOOR_KEY = 'nfa_floor';              // editable NFA buying-price overrides (Owner-managed)
const MAX_LOG_ENTRIES = 1000;                      // cap to keep KV value small
const MIN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;    // 1 hour between on-demand refreshes
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;     // 30 days
const PBKDF2_ITERATIONS = 100000;                  // PBKDF2 SHA-256 cost
const ROLES = { OWNER: 'owner', MANAGER: 'manager' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Anything outside /api/* is a static asset (the SPA, served from ./public)
    if (!url.pathname.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not Found', { status: 404 });
    }

    // Manual refresh (admin)
    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      const secret = request.headers.get('X-Admin-Secret');
      if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      const fresh = await scrapeAndStore(env);
      return jsonResponse(fresh);
    }

    // Health
    if (url.pathname === '/api/health') {
      return jsonResponse({ ok: true, now: new Date().toISOString() });
    }

    // ============================================================
    // AUTH ENDPOINTS
    // ============================================================

    // POST /api/login → { token, user }
    if (url.pathname === '/api/login' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
      const email = normalizeEmail(body && body.email);
      const password = (body && body.password) || '';
      if (!email || !password) return jsonResponse({ error: 'email and password required' }, 400);
      const users = await readUsers(env);
      const user = users[email];
      if (!user) return jsonResponse({ error: 'invalid credentials' }, 401);
      const ok = await verifyPassword(password, user);
      if (!ok) return jsonResponse({ error: 'invalid credentials' }, 401);
      const token = await createSession(env, user.email);
      return jsonResponse({ token, user: publicUser(user) });
    }

    // POST /api/logout
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      const token = bearerToken(request);
      if (token) await deleteSession(env, token);
      return jsonResponse({ ok: true });
    }

    // GET /api/me
    if (url.pathname === '/api/me' && request.method === 'GET') {
      const ctxAuth = await resolveSession(request, env);
      if (!ctxAuth.user) {
        // Help the frontend bootstrap: tell it whether any users exist
        // (boolean only — exact count is not the public's business).
        const users = await readUsers(env);
        const needsBootstrap = Object.keys(users).length === 0;
        return jsonResponse({ user: null, needsBootstrap }, 200);
      }
      return jsonResponse({ user: publicUser(ctxAuth.user) });
    }

    // POST /api/password — change own password
    if (url.pathname === '/api/password' && request.method === 'POST') {
      const ctxAuth = await resolveSession(request, env);
      if (!ctxAuth.user) return jsonResponse({ error: 'unauthorized' }, 401);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
      const currentPw = (body && body.currentPassword) || '';
      const newPw = (body && body.newPassword) || '';
      if (newPw.length < 8) return jsonResponse({ error: 'new password must be at least 8 characters' }, 400);
      const ok = await verifyPassword(currentPw, ctxAuth.user);
      if (!ok) return jsonResponse({ error: 'current password is wrong' }, 401);
      const users = await readUsers(env);
      const updated = await applyPassword(users[ctxAuth.user.email], newPw);
      users[updated.email] = updated;
      await writeUsers(env, users);
      return jsonResponse({ ok: true });
    }

    // ============================================================
    // USERS (Owner-managed, except first-owner bootstrap)
    // ============================================================
    if (url.pathname === '/api/users') {
      const users = await readUsers(env);
      const userCount = Object.keys(users).length;

      // Bootstrap: when there are no users, allow creating the first Owner with X-Admin-Secret.
      if (request.method === 'POST' && userCount === 0) {
        const secret = request.headers.get('X-Admin-Secret');
        if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
          return jsonResponse({ error: 'no users yet — first user requires X-Admin-Secret' }, 401);
        }
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
        const created = await buildNewUser(body, ROLES.OWNER);
        if (created.error) return jsonResponse({ error: created.error }, 400);
        users[created.user.email] = created.user;
        await writeUsers(env, users);
        return jsonResponse({ ok: true, user: publicUser(created.user) });
      }

      const ctxAuth = await resolveSession(request, env);
      if (!ctxAuth.user || ctxAuth.user.role !== ROLES.OWNER) {
        return jsonResponse({ error: 'owner required' }, 403);
      }

      if (request.method === 'GET') {
        return jsonResponse({ users: Object.values(users).map(publicUser) });
      }
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
        const desiredRole = body && body.role === ROLES.OWNER ? ROLES.OWNER : ROLES.MANAGER;
        const created = await buildNewUser(body, desiredRole);
        if (created.error) return jsonResponse({ error: created.error }, 400);
        if (users[created.user.email]) return jsonResponse({ error: 'user already exists' }, 409);
        users[created.user.email] = created.user;
        await writeUsers(env, users);
        return jsonResponse({ ok: true, user: publicUser(created.user) });
      }
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    if (url.pathname.startsWith('/api/users/')) {
      const target = normalizeEmail(decodeURIComponent(url.pathname.slice('/api/users/'.length)));
      if (!target) return jsonResponse({ error: 'missing email' }, 400);
      const ctxAuth = await resolveSession(request, env);
      if (!ctxAuth.user || ctxAuth.user.role !== ROLES.OWNER) {
        return jsonResponse({ error: 'owner required' }, 403);
      }
      const users = await readUsers(env);
      const existing = users[target];
      if (!existing) return jsonResponse({ error: 'not found' }, 404);

      if (request.method === 'PUT') {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
        let updated = { ...existing };
        if (typeof body.name === 'string') updated.name = body.name.trim().slice(0, 80);
        if (body.role === ROLES.OWNER || body.role === ROLES.MANAGER) {
          // Don't allow demoting the only Owner.
          if (existing.role === ROLES.OWNER && body.role !== ROLES.OWNER) {
            const otherOwners = Object.values(users).filter(u => u.role === ROLES.OWNER && u.email !== existing.email);
            if (otherOwners.length === 0) return jsonResponse({ error: 'cannot demote the only Owner' }, 400);
          }
          updated.role = body.role;
        }
        if (typeof body.password === 'string' && body.password.length > 0) {
          if (body.password.length < 8) return jsonResponse({ error: 'password must be at least 8 characters' }, 400);
          updated = await applyPassword(updated, body.password);
        }
        updated.updatedAt = new Date().toISOString();
        users[target] = updated;
        await writeUsers(env, users);
        return jsonResponse({ ok: true, user: publicUser(updated) });
      }

      if (request.method === 'DELETE') {
        if (target === ctxAuth.user.email) return jsonResponse({ error: 'cannot delete yourself' }, 400);
        if (existing.role === ROLES.OWNER) {
          const otherOwners = Object.values(users).filter(u => u.role === ROLES.OWNER && u.email !== existing.email);
          if (otherOwners.length === 0) return jsonResponse({ error: 'cannot delete the only Owner' }, 400);
        }
        delete users[target];
        await writeUsers(env, users);
        return jsonResponse({ ok: true, deleted: target });
      }

      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    // ============================================================
    // OPERATIONAL DATA (areas, harvest, equipment, accounting, etc.)
    // Single JSON blob; PATCH merges, GET returns full state.
    // ============================================================
    if (url.pathname === '/api/ops') {
      const ctxAuth = await resolveSession(request, env);
      if (!ctxAuth.user) return jsonResponse({ error: 'unauthorized' }, 401);

      if (request.method === 'GET') {
        const ops = await readOps(env);
        return jsonResponse({
          ops,
          updatedAt: ops._updatedAt || null,
          updatedBy: ops._updatedBy || null,
        });
      }

      if (request.method === 'PATCH') {
        let patch;
        try { patch = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return jsonResponse({ error: 'patch must be a JSON object' }, 400);
        }
        const current = await readOps(env);
        const merged = { ...current };
        for (const [k, v] of Object.entries(patch)) {
          if (k.startsWith('_')) continue; // do not let clients set internal _updatedAt etc
          merged[k] = v;
        }
        merged._updatedAt = new Date().toISOString();
        merged._updatedBy = ctxAuth.user.email;
        await writeOps(env, merged);
        return jsonResponse({ ok: true, updatedAt: merged._updatedAt, updatedBy: merged._updatedBy });
      }

      if (request.method === 'PUT') {
        // Full replace — used by Restore-from-backup. Owner-only for safety.
        if (ctxAuth.user.role !== ROLES.OWNER) return jsonResponse({ error: 'owner required' }, 403);
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return jsonResponse({ error: 'body must be a JSON object' }, 400);
        }
        const fresh = { ...body };
        delete fresh._updatedAt; delete fresh._updatedBy;
        fresh._updatedAt = new Date().toISOString();
        fresh._updatedBy = ctxAuth.user.email;
        await writeOps(env, fresh);
        return jsonResponse({ ok: true, replaced: true, updatedAt: fresh._updatedAt });
      }

      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    // ============================================================
    // MAPS CONFIG — surfaces front-end config the worker needs to hand
    // to the browser. Currently just the Google Maps API key (when set).
    // Key is fine to expose to authenticated users because it is HTTP
    // referrer-restricted to abundance.mak-ct.com.
    // ============================================================
    if (url.pathname === '/api/maps-config' && request.method === 'GET') {
      const ctxAuth = await resolveSession(request, env);
      if (!ctxAuth.user) return jsonResponse({ error: 'unauthorized' }, 401);
      return jsonResponse({
        googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || null,
      });
    }

    // ============================================================
    // NDVI INFO — when was the most recent Sentinel-2 image captured?
    // GET /api/ndvi-info?lat=X&lon=Y[&days=30][&maxcc=30]
    //   returns: { date: 'YYYY-MM-DD', cloudCoverPercentage: N, count: N }
    // Uses Sentinel Hub WFS to query the catalog for the bounding box.
    // ============================================================
    if (url.pathname === '/api/ndvi-info') {
      if (!env.SENTINEL_HUB_INSTANCE_ID) {
        return jsonResponse({ error: 'NDVI not configured' }, 503);
      }
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      const reqDays  = Math.max(7, Math.min(365, parseInt(url.searchParams.get('days')  || '90', 10)));
      const reqMaxCc = Math.max(0, Math.min(100, parseInt(url.searchParams.get('maxcc') || '60', 10)));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return jsonResponse({ error: 'lat and lon required' }, 400);
      }
      // Small bounding box around the point (~5km), wide enough to capture a tile.
      // WFS 2.0 + EPSG:4326 → axis order is lat,lon (per OGC spec). Sentinel Hub
      // honours this; sending lon,lat returns 200 with zero features, which is
      // indistinguishable from "no coverage". Keep lat,lon to actually match.
      const pad = 0.05;
      const bbox = `${lat - pad},${lon - pad},${lat + pad},${lon + pad}`;

      // Progressive fallback ladder — tropical wet-season clouds often defeat
      // a strict query. Start with caller's strict request, then widen until
      // we find at least one usable image.
      const ladder = [
        { days: reqDays,                    maxcc: reqMaxCc },
        { days: reqDays,                    maxcc: Math.min(100, reqMaxCc + 20) },
        { days: Math.min(180, reqDays + 90), maxcc: Math.min(100, reqMaxCc + 20) },
        { days: Math.min(365, reqDays + 180), maxcc: 100 },
      ];

      // Sentinel Hub feature-type names vary by data source. For Copernicus
      // Data Space Sentinel-2 L2A it's "DSS2A"; older instances use "DSS2"
      // (which is actually L1C). Try the configured one first, then fall back.
      const typeNamesToTry = (env.SENTINEL_HUB_TYPENAMES || 'DSS2A,DSS2,DSS3').split(',').map(s => s.trim()).filter(Boolean);

      const queryFor = async ({ days, maxcc }, typeName) => {
        const today = new Date().toISOString().slice(0, 10);
        const past = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
        const wfs = new URL(`https://sh.dataspace.copernicus.eu/ogc/wfs/${env.SENTINEL_HUB_INSTANCE_ID}`);
        wfs.searchParams.set('SERVICE', 'WFS');
        wfs.searchParams.set('VERSION', '2.0.0');
        wfs.searchParams.set('REQUEST', 'GetFeature');
        wfs.searchParams.set('TYPENAMES', typeName);
        wfs.searchParams.set('BBOX', bbox);
        wfs.searchParams.set('SRSNAME', 'EPSG:4326');
        wfs.searchParams.set('TIME', `${past}/${today}`);
        wfs.searchParams.set('MAXFEATURES', '20');
        wfs.searchParams.set('MAXCC', String(maxcc));
        wfs.searchParams.set('OUTPUTFORMAT', 'application/json');
        const r = await fetch(wfs.toString());
        if (!r.ok) {
          const t = await r.text();
          // 400 typically means TYPENAMES is wrong for this configuration — let the loop continue.
          if (r.status === 400) return { invalidType: true, error: t.slice(0, 200) };
          throw new Error(`WFS ${r.status}: ${t.slice(0, 200)}`);
        }
        const j = await r.json();
        return { features: (j && Array.isArray(j.features)) ? j.features : [] };
      };

      try {
        let feats = [];
        let usedDays = reqDays, usedMaxCc = reqMaxCc, usedType = null;
        let typeErrors = [];

        // Find which TYPENAMES works (one HTTP probe per candidate, cheap)
        let workingType = null;
        for (const tn of typeNamesToTry) {
          const probe = await queryFor(ladder[ladder.length - 1], tn);  // most permissive bucket
          if (probe.invalidType) { typeErrors.push(`${tn}: ${probe.error}`); continue; }
          workingType = tn;
          // The probe itself may have returned features — re-use rather than re-query
          if (probe.features && probe.features.length > 0) feats = probe.features;
          break;
        }
        if (!workingType) {
          return jsonResponse({
            error: 'No working WFS data source. Set SENTINEL_HUB_TYPENAMES (tried: ' + typeNamesToTry.join(', ') + ').',
            detail: typeErrors,
          }, 502);
        }
        usedType = workingType;

        // Now run the proper ladder against the working type, narrowest-first
        if (feats.length === 0) {
          for (const step of ladder) {
            const r = await queryFor(step, workingType);
            if (r.features && r.features.length > 0) {
              feats = r.features;
              usedDays = step.days; usedMaxCc = step.maxcc;
              break;
            }
          }
        }

        if (feats.length === 0) {
          return jsonResponse({
            date: null, cloudCoverPercentage: null, count: 0,
            message: `No Sentinel-2 images found in the last year, even at 100% cloud cover. Parcel may be outside Sentinel-2 coverage.`,
            usedType,
          });
        }
        feats.sort((a, b) => {
          const da = (a.properties && (a.properties.date || a.properties.time)) || '';
          const db = (b.properties && (b.properties.date || b.properties.time)) || '';
          return db.localeCompare(da);
        });
        const top = feats[0].properties || {};
        return jsonResponse({
          date: top.date || top.time || null,
          cloudCoverPercentage: top.cloudCoverPercentage != null ? top.cloudCoverPercentage : null,
          count: feats.length,
          previousDate: feats[1] ? ((feats[1].properties || {}).date || null) : null,
          searchedDays: usedDays,
          searchedMaxCc: usedMaxCc,
          relaxedFromRequest: (usedDays !== reqDays || usedMaxCc !== reqMaxCc),
          usedType,
        });
      } catch (e) {
        return jsonResponse({ error: 'WFS fetch failed: ' + (e.message || String(e)) }, 502);
      }
    }

    // ============================================================
    // NDVI TILE PROXY — Sentinel Hub WMS, keeps instance ID server-side
    // GET /api/ndvi-tile?z=X&x=Y&y=Z   (XYZ slippy-tile convention)
    // GET /api/ndvi-tile?probe=1       (returns 200 if configured, 404 if not)
    // Requires SENTINEL_HUB_INSTANCE_ID env var. Free-tier accounts can
    // configure a WMS layer named NDVI in the dashboard.
    // ============================================================
    if (url.pathname === '/api/ndvi-tile') {
      const probe = url.searchParams.get('probe');
      if (probe) {
        return env.SENTINEL_HUB_INSTANCE_ID
          ? jsonResponse({ ok: true })
          : jsonResponse({ error: 'SENTINEL_HUB_INSTANCE_ID not set' }, 404);
      }
      if (!env.SENTINEL_HUB_INSTANCE_ID) {
        return jsonResponse({ error: 'NDVI not configured' }, 503);
      }
      const z = parseInt(url.searchParams.get('z'), 10);
      const x = parseInt(url.searchParams.get('x'), 10);
      const y = parseInt(url.searchParams.get('y'), 10);
      if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
        return jsonResponse({ error: 'z, x, y required' }, 400);
      }
      // XYZ → bbox (EPSG:3857)
      const tileSize = 40075016.686 / Math.pow(2, z);
      const minX = -20037508.343 + x * tileSize;
      const maxX = -20037508.343 + (x + 1) * tileSize;
      const minY =  20037508.343 - (y + 1) * tileSize;
      const maxY =  20037508.343 -  y * tileSize;
      const layerName = env.SENTINEL_HUB_LAYER_NAME || 'NDVI';
      // Copernicus Data Space accounts use sh.dataspace.copernicus.eu;
      // legacy Sentinel Hub accounts use services.sentinel-hub.com.
      const wmsHost = env.SENTINEL_HUB_WMS_HOST || 'https://sh.dataspace.copernicus.eu';
      const wms = new URL(`${wmsHost}/ogc/wms/${env.SENTINEL_HUB_INSTANCE_ID}`);
      wms.searchParams.set('SERVICE', 'WMS');
      wms.searchParams.set('REQUEST', 'GetMap');
      wms.searchParams.set('LAYERS', layerName);
      wms.searchParams.set('MAXCC', '20');
      wms.searchParams.set('WIDTH', '256');
      wms.searchParams.set('HEIGHT', '256');
      wms.searchParams.set('FORMAT', 'image/png');
      wms.searchParams.set('TRANSPARENT', 'true');
      wms.searchParams.set('CRS', 'EPSG:3857');
      wms.searchParams.set('BBOX', `${minX},${minY},${maxX},${maxY}`);
      wms.searchParams.set('TIME', 'P1M/' + new Date().toISOString().slice(0,10));
      try {
        const upstream = await fetch(wms.toString());
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=21600', ...CORS_HEADERS },
        });
      } catch (e) {
        return jsonResponse({ error: 'NDVI fetch failed: ' + e.message }, 502);
      }
    }

    // ============================================================
    // CROP DIAGNOSIS — supervisor field tool
    // Takes a photo of a leaf/plant/pest and asks Claude vision for
    // identification + recommended action. Any signed-in user can call it.
    // ============================================================
    if (url.pathname === '/api/diagnose' && request.method === 'POST') {
      const ctxAuth = await resolveSession(request, env);
      if (!ctxAuth.user) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!env.ANTHROPIC_API_KEY) {
        return jsonResponse({ error: 'ANTHROPIC_API_KEY secret not set — owner must run: wrangler secret put ANTHROPIC_API_KEY' }, 503);
      }
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
      const image = body && body.image;        // expected: "data:image/jpeg;base64,...." or just base64
      const areaName = (body && body.areaName) || '(unknown area)';
      const cropType = (body && body.cropType) || 'rice or corn';
      const notes    = (body && body.notes) || '';
      if (!image || typeof image !== 'string') {
        return jsonResponse({ error: 'image (base64 data URL) is required' }, 400);
      }
      // Parse the data URL → { mediaType, base64 }
      let mediaType = 'image/jpeg';
      let b64 = image;
      const m = image.match(/^data:([^;]+);base64,(.+)$/);
      if (m) { mediaType = m[1]; b64 = m[2]; }
      // Cap payload (1.5MB base64 ≈ 1MB image — Claude vision can handle, but Worker has limits)
      if (b64.length > 4_500_000) {
        return jsonResponse({ error: 'image too large — resize to under 3MB before upload' }, 413);
      }

      const prompt = `You are an agricultural advisor for a Philippine farmer in Cagayan Valley (Region 2). The farmer's supervisor just took this photo at an area called "${areaName}" planted with ${cropType}.${notes ? ` Supervisor notes: "${notes}".` : ''}

Look at the image and tell me:
1. What you see (plant part, growth stage, visible symptoms or organisms)
2. Most likely diagnosis (pest, disease, deficiency, normal growth, or unclear)
3. Confidence level (high / medium / low)
4. Immediate recommended action — keep it concrete and locally-relevant. Refer to common Philippine products and practices when possible. If a chemical treatment is needed, name an active ingredient, not a brand.
5. Whether the owner should walk the field today (URGENT) or it can wait until the next scheduled visit (ROUTINE)

Respond as JSON with this exact shape, no extra prose:
{
  "observation": "what you see, 1-2 sentences",
  "diagnosis": "name of the issue",
  "confidence": "high|medium|low",
  "action": "what to do, 1-3 sentences",
  "urgency": "URGENT|ROUTINE",
  "notes": "anything else worth flagging, optional"
}`;

      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
                { type: 'text', text: prompt },
              ],
            }],
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          return jsonResponse({ error: `Claude API ${resp.status}: ${errText.slice(0, 400)}` }, 502);
        }
        const data = await resp.json();
        const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
        let parsed = null;
        // Tolerate fences / leading prose
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { parsed = JSON.parse(jsonMatch[0]); } catch (e) { /* fall through */ }
        }
        return jsonResponse({
          ok: true,
          diagnosis: parsed || { raw: text },
          model: data.model,
          usage: data.usage,
          by: ctxAuth.user.email,
          at: new Date().toISOString(),
        });
      } catch (e) {
        return jsonResponse({ error: 'diagnose call failed: ' + (e.message || String(e)) }, 502);
      }
    }

    // ============================================================
    // LOGGED FARMGATE PRICES (session-gated for writes)
    // ============================================================
    if (url.pathname === '/api/log') {
      if (request.method === 'GET') {
        const log = await readLog(env);
        return jsonResponse({ entries: log, count: log.length });
      }
      if (request.method === 'POST') {
        const ctxAuth = await resolveSession(request, env);
        if (!ctxAuth.user) return jsonResponse({ error: 'unauthorized' }, 401);
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
        const entry = sanitizeEntry(body, { author: ctxAuth.user.email, authorName: ctxAuth.user.name });
        if (!entry) return jsonResponse({ error: 'invalid entry: need date and at least one price' }, 400);
        const log = await readLog(env);
        log.push(entry);
        log.sort((a, b) => new Date(b.date) - new Date(a.date));
        const trimmed = log.length > MAX_LOG_ENTRIES ? log.slice(0, MAX_LOG_ENTRIES) : log;
        await writeLog(env, trimmed);
        return jsonResponse({ ok: true, entry, count: trimmed.length });
      }
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    if (url.pathname.startsWith('/api/log/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/log/'.length));
      if (!id) return jsonResponse({ error: 'missing id' }, 400);
      const ctxAuth = await resolveSession(request, env);
      if (!ctxAuth.user) return jsonResponse({ error: 'unauthorized' }, 401);
      const log = await readLog(env);
      const idx = log.findIndex(e => e.id === id);
      if (idx === -1) return jsonResponse({ error: 'not found' }, 404);
      const target = log[idx];
      const isOwner = ctxAuth.user.role === ROLES.OWNER;
      const isAuthor = target.author && target.author === ctxAuth.user.email;
      if (!isOwner && !isAuthor) return jsonResponse({ error: 'forbidden — managers can only modify their own entries' }, 403);

      if (request.method === 'DELETE') {
        log.splice(idx, 1);
        await writeLog(env, log);
        return jsonResponse({ ok: true, deleted: id, count: log.length });
      }
      if (request.method === 'PUT') {
        let body;
        try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
        const updated = sanitizeEntry({ ...target, ...body, id }, { author: target.author || ctxAuth.user.email, authorName: target.authorName });
        if (!updated) return jsonResponse({ error: 'invalid entry' }, 400);
        log[idx] = updated;
        log.sort((a, b) => new Date(b.date) - new Date(a.date));
        await writeLog(env, log);
        return jsonResponse({ ok: true, entry: updated, count: log.length });
      }
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    // Prices
    if (url.pathname === '/api/prices.json' || url.pathname === '/api/prices') {
      let data = await readCache(env);
      const shouldRefresh = url.searchParams.get('refresh') === '1'
        && (!data || !data.fetchedAt || Date.now() - new Date(data.fetchedAt).getTime() > MIN_REFRESH_INTERVAL_MS);
      if (shouldRefresh || !data) {
        try {
          data = await scrapeAndStore(env);
        } catch (err) {
          if (!data) return jsonResponse({ error: 'no cache and scrape failed', detail: String(err) }, 503);
        }
      }
      return jsonResponse(data);
    }

    // NFA government floor price.
    // GET: read merged values (KV override wins over env-var defaults).
    // PATCH: Owner-only — write overrides to KV with editor + timestamp.
    if (url.pathname === '/api/prices/floor' && request.method === 'GET') {
      const data = await readFloorMerged(env);
      return jsonResponse(data);
    }

    if (url.pathname === '/api/prices/floor' && request.method === 'PATCH') {
      const ctxAuth = await resolveSession(request, env);
      if (!ctxAuth.user || ctxAuth.user.role !== ROLES.OWNER) {
        return jsonResponse({ error: 'owner required' }, 403);
      }
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }

      const numOrNull = (v) => {
        if (v === null || v === '' || v === undefined) return null;
        const n = parseFloat(v);
        return isFinite(n) && n > 0 && n < 10000 ? n : undefined;  // undefined = invalid
      };
      const validated = {};
      for (const key of ['palayFresh', 'palayDry', 'palayPremium', 'cagayanDry']) {
        if (key in (body.nfa || {})) {
          const n = numOrNull(body.nfa[key]);
          if (n === undefined) return jsonResponse({ error: `invalid value for ${key}` }, 400);
          validated[key] = n;
        }
      }
      // Read existing overrides, merge in changes
      const existing = (await readFloorOverrides(env)) || {};
      const merged = { ...(existing.nfa || {}), ...validated };
      const record = {
        nfa: merged,
        verifiedAt: typeof body.verifiedAt === 'string' ? body.verifiedAt : (new Date().toISOString().slice(0, 10)),
        note: typeof body.note === 'string' ? body.note : (existing.note || null),
        sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : (existing.sourceUrl || null),
        updatedAt: new Date().toISOString(),
        updatedBy: ctxAuth.user.email,
      };
      await writeFloorOverrides(env, record);
      const fresh = await readFloorMerged(env);
      return jsonResponse({ ok: true, ...fresh });
    }

    // Diagnostic: per-source attempt info. Lets us see what PSA returned,
    // dimension codes, errors etc. Requires X-Admin-Secret or owner session.
    if (url.pathname === '/api/prices/sources' && request.method === 'GET') {
      const secret = request.headers.get('X-Admin-Secret');
      let authorized = !!(env.ADMIN_SECRET && secret === env.ADMIN_SECRET);
      if (!authorized) {
        const ctxAuth = await resolveSession(request, env);
        authorized = !!(ctxAuth.user && ctxAuth.user.role === ROLES.OWNER);
      }
      if (!authorized) return jsonResponse({ error: 'admin only' }, 401);
      const data = await readCache(env);
      return jsonResponse({
        mode: env.SOURCE_MODE || 'sheet',
        fetchedAt: data && data.fetchedAt || null,
        source: data && data.source || null,
        attempts: data && data.attempts || [],
        rowCount: data && Array.isArray(data.rows) ? data.rows.length : 0,
      });
    }

    // Probe a custom PSA query (admin) — lets us send arbitrary queries
    // to figure out PSA's API quirks.
    if (url.pathname === '/api/prices/psa-test' && request.method === 'POST') {
      const secret = request.headers.get('X-Admin-Secret');
      let authorized = !!(env.ADMIN_SECRET && secret === env.ADMIN_SECRET);
      if (!authorized) {
        const ctxAuth = await resolveSession(request, env);
        authorized = !!(ctxAuth.user && ctxAuth.user.role === ROLES.OWNER);
      }
      if (!authorized) return jsonResponse({ error: 'admin only' }, 401);

      const body = await request.json().catch(() => ({}));
      const tableUrl = `${env.PSA_OPENSTAT_API_BASE || 'https://openstat.psa.gov.ph/PXWeb/api/v1/en/DB'}/${body.tablePath || '2M/NFG/0032M4AFN01.px'}`;
      const psaBody = body.query;
      const results = { tableUrl, queries: [] };

      // Run each query variant the user supplies (or default to a tiny test).
      const variants = body.variants || [psaBody];
      for (const v of variants) {
        try {
          const res = await fetch(tableUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(v),
          });
          const raw = await res.text();
          let parsed;
          try { parsed = JSON.parse(raw); } catch(e) { parsed = null; }
          results.queries.push({
            query: v,
            status: res.status,
            contentType: res.headers.get('content-type'),
            isJson: !!parsed,
            id: parsed && parsed.id,
            size: parsed && parsed.size,
            valueLength: parsed && Array.isArray(parsed.value) ? parsed.value.length : (parsed && parsed.value ? Object.keys(parsed.value).length : 0),
            valueFirst: parsed && parsed.value && (Array.isArray(parsed.value) ? parsed.value.slice(0, 20) : Object.entries(parsed.value).slice(0, 20)),
            rawSnippet: raw.slice(0, 600),
          });
        } catch (err) {
          results.queries.push({ query: v, error: String(err && err.message || err) });
        }
      }
      return jsonResponse(results);
    }

    // Discovery probe (admin) — fetches multiple PSA URL variations to find
    // which one PSA's API actually responds to. Each entry returns HTTP status,
    // content-type, and a short body preview. Use this to figure out the right
    // path when PSA changes their API layout.
    if (url.pathname === '/api/prices/probe' && request.method === 'GET') {
      const secret = request.headers.get('X-Admin-Secret');
      let authorized = !!(env.ADMIN_SECRET && secret === env.ADMIN_SECRET);
      if (!authorized) {
        const ctxAuth = await resolveSession(request, env);
        authorized = !!(ctxAuth.user && ctxAuth.user.role === ROLES.OWNER);
      }
      if (!authorized) return jsonResponse({ error: 'admin only' }, 401);

      const candidates = [
        // Conventional PX-Web API paths
        'https://openstat.psa.gov.ph/PXWeb/api/v1/en',
        'https://openstat.psa.gov.ph/PXWeb/api/v1/en/DB',
        'https://openstat.psa.gov.ph/PXWeb/api/v1/en/DB/DB__2M__FG',
        'https://openstat.psa.gov.ph/PXWeb/api/v1/en/DB/DB__2M__FG/0032M4AFP01.px',
        // PX-Web 2 API
        'https://openstat.psa.gov.ph/PXWeb/api/v2/en',
        // Without /PXWeb prefix
        'https://openstat.psa.gov.ph/api/v1/en/DB',
        // UI path (HTML response)
        'https://openstat.psa.gov.ph/PXWeb/pxweb/en/DB/DB__2M__FG/0032M4AFP01.px/',
        // Try lowercase
        'https://openstat.psa.gov.ph/pxweb/api/v1/en/DB',
      ];

      const results = [];
      for (const u of candidates) {
        try {
          const res = await fetch(u, {
            headers: { 'User-Agent': 'AbundanceFarmProbe/1.0', 'Accept': '*/*' },
            cf: { cacheTtl: 60, cacheEverything: false },
          });
          const ct = res.headers.get('content-type') || '';
          const buf = await res.arrayBuffer();
          const text = new TextDecoder('utf-8').decode(buf.slice(0, 500));
          results.push({
            url: u, status: res.status, contentType: ct,
            bytes: buf.byteLength, preview: text,
          });
        } catch (err) {
          results.push({ url: u, error: String(err && err.message || err) });
        }
      }
      return jsonResponse({ results });
    }

    // Force-refresh (admin) — same as ?refresh=1 but bypasses rate limit
    // and returns the diagnostic info inline. Useful when we change config.
    if (url.pathname === '/api/prices/refresh' && request.method === 'POST') {
      const secret = request.headers.get('X-Admin-Secret');
      let authorized = !!(env.ADMIN_SECRET && secret === env.ADMIN_SECRET);
      if (!authorized) {
        const ctxAuth = await resolveSession(request, env);
        authorized = !!(ctxAuth.user && ctxAuth.user.role === ROLES.OWNER);
      }
      if (!authorized) return jsonResponse({ error: 'admin only' }, 401);
      try {
        // Direct PSA fetch (bypassing the merge) so we can see what actually came back.
        const psaProbe = await safeFetchPsaFarmgate(env);
        const fresh = await scrapeAndStore(env);
        return jsonResponse({
          ok: true,
          fetchedAt: fresh.fetchedAt,
          source: fresh.source,
          attempts: fresh.attempts,
          rowCount: Array.isArray(fresh.rows) ? fresh.rows.length : 0,
          sample: Array.isArray(fresh.rows) ? fresh.rows.slice(0, 3) : [],
          psaRawRowCount: (psaProbe.rows || []).length,
          psaRawRows: (psaProbe.rows || []).slice(0, 20),
          psaDebug: psaProbe.debug,
        });
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err && err.message || err) }, 500);
      }
    }

    return jsonResponse({ error: 'not found' }, 404);
  },

  // Cloudflare cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scrapeAndStore(env).catch(err => console.error('Scheduled scrape failed:', err)));
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

async function readCache(env) {
  try {
    if (!env.PRICES) return null;
    const raw = await env.PRICES.get(KV_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function writeCache(env, data) {
  try { if (env.PRICES) await env.PRICES.put(KV_KEY, JSON.stringify(data)); } catch (e) {}
}

// ============================================================
// NFA FLOOR PRICE — env-var defaults overridable by Owner via KV
// ============================================================
// Owners can edit floor prices through the UI (PATCH /api/prices/floor).
// Overrides live in KV under KV_NFA_FLOOR_KEY. GET merges KV over env so
// that any field NOT overridden falls back to the wrangler.toml default.
async function readFloorOverrides(env) {
  try {
    if (!env.PRICES) return null;
    const raw = await env.PRICES.get(KV_NFA_FLOOR_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

async function writeFloorOverrides(env, record) {
  try { if (env.PRICES) await env.PRICES.put(KV_NFA_FLOOR_KEY, JSON.stringify(record)); } catch (e) {}
}

async function readFloorMerged(env) {
  const num = (v) => {
    const n = parseFloat(v);
    return isFinite(n) && n > 0 ? n : null;
  };
  const envDefaults = {
    palayFresh:   num(env.NFA_PALAY_FRESH),
    palayDry:     num(env.NFA_PALAY_DRY),
    palayPremium: num(env.NFA_PALAY_PREMIUM),
    cagayanDry:   num(env.NFA_CAGAYAN_DRY),
  };
  const override = await readFloorOverrides(env);
  const merged = { ...envDefaults };
  if (override && override.nfa) {
    for (const k of Object.keys(override.nfa)) {
      if (override.nfa[k] != null) merged[k] = override.nfa[k];
    }
  }
  return {
    nfa: merged,
    verifiedAt: (override && override.verifiedAt) || env.NFA_LAST_VERIFIED || null,
    note:       (override && override.note)       || env.NFA_NOTE || null,
    sourceUrl:  (override && override.sourceUrl)  || env.NFA_SOURCE_URL || null,
    updatedAt:  (override && override.updatedAt)  || null,
    updatedBy:  (override && override.updatedBy)  || null,
    hasOverride: !!override,
  };
}

// ============================================================
// LOGGED PRICES (server-stored, syncs across devices)
// ============================================================
async function readLog(env) {
  try {
    if (!env.PRICES) return [];
    const raw = await env.PRICES.get(KV_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

async function writeLog(env, entries) {
  try { if (env.PRICES) await env.PRICES.put(KV_LOG_KEY, JSON.stringify(entries)); } catch (e) {}
}

// ----- Operational data blob -----
async function readOps(env) {
  try {
    if (!env.PRICES) return {};
    const raw = await env.PRICES.get(KV_OPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) { return {}; }
}

async function writeOps(env, ops) {
  if (!env.PRICES) return;
  await env.PRICES.put(KV_OPS_KEY, JSON.stringify(ops));
}

// Coerce a raw payload into a clean log entry. Returns null if invalid.
// Required: a date and at least one numeric price field.
function sanitizeEntry(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  const dateStr = String(raw.date || '').trim();
  if (!dateStr) return null;
  const d = new Date(dateStr.length === 10 ? dateStr + 'T12:00:00' : dateStr);
  if (isNaN(d.getTime())) return null;

  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : Math.round(n * 100) / 100;
  };

  const palayFresh = num(raw.palayFresh);
  const palayDry   = num(raw.palayDry);
  const cornFresh  = num(raw.cornFresh);
  const cornDry    = num(raw.cornDry);
  if (palayFresh == null && palayDry == null && cornFresh == null && cornDry == null) return null;

  const id = (typeof raw.id === 'string' && raw.id) ? raw.id : makeId();
  return {
    id,
    date: d.toISOString(),
    palayFresh, palayDry, cornFresh, cornDry,
    source: typeof raw.source === 'string' ? raw.source.trim().slice(0, 80) : '',  // free-form: "FB - X", "mill A", "neighbor", ""
    note:   typeof raw.note   === 'string' ? raw.note.slice(0, 200) : '',
    author: (ctx && ctx.author) || raw.author || null,
    authorName: (ctx && ctx.authorName) || raw.authorName || null,
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeId() {
  // Short stable id: timestamp + 5 random chars. Fine for single-user.
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ============================================================
// AUTH: users, sessions, password hashing (Web Crypto / PBKDF2)
// ============================================================
async function readUsers(env) {
  try {
    if (!env.PRICES) return {};
    const raw = await env.PRICES.get(KV_USERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) { return {}; }
}

async function writeUsers(env, users) {
  if (!env.PRICES) return;
  await env.PRICES.put(KV_USERS_KEY, JSON.stringify(users));
}

function normalizeEmail(e) {
  if (typeof e !== 'string') return '';
  const t = e.trim().toLowerCase();
  // Minimal email check; the goal is to use it as a stable key.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : '';
}

function publicUser(u) {
  if (!u) return null;
  return { email: u.email, name: u.name || '', role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt };
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveHash(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

async function applyPassword(user, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
  return {
    ...user,
    pwSalt: bytesToBase64(salt),
    pwHash: bytesToBase64(hash),
    pwIter: PBKDF2_ITERATIONS,
    updatedAt: new Date().toISOString(),
  };
}

async function verifyPassword(password, user) {
  if (!user || !user.pwSalt || !user.pwHash) return false;
  try {
    const salt = base64ToBytes(user.pwSalt);
    const expected = base64ToBytes(user.pwHash);
    const got = await deriveHash(password, salt, user.pwIter || PBKDF2_ITERATIONS);
    if (got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
    return diff === 0;
  } catch (e) { return false; }
}

async function buildNewUser(body, role) {
  const email = normalizeEmail(body && body.email);
  const name = (body && typeof body.name === 'string') ? body.name.trim().slice(0, 80) : '';
  const password = (body && body.password) || '';
  if (!email) return { error: 'invalid email' };
  if (password.length < 8) return { error: 'password must be at least 8 characters' };
  const now = new Date().toISOString();
  let user = { email, name, role, createdAt: now, updatedAt: now };
  user = await applyPassword(user, password);
  return { user };
}

// ----- Sessions -----
function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+([A-Za-z0-9._-]+)$/);
  return m ? m[1] : '';
}

function sessionKey(token) { return 'session:' + token; }

async function createSession(env, email) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(tokenBytes);
  const now = Date.now();
  const record = { email, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString() };
  if (env.PRICES) {
    await env.PRICES.put(sessionKey(token), JSON.stringify(record), { expirationTtl: SESSION_TTL_SECONDS });
  }
  return token;
}

async function deleteSession(env, token) {
  if (!token || !env.PRICES) return;
  try { await env.PRICES.delete(sessionKey(token)); } catch (e) {}
}

// Returns { user } if a valid session token is present, else { user: null }
async function resolveSession(request, env) {
  const token = bearerToken(request);
  if (!token || !env.PRICES) return { user: null };
  let record;
  try {
    const raw = await env.PRICES.get(sessionKey(token));
    record = raw ? JSON.parse(raw) : null;
  } catch (e) { record = null; }
  if (!record || !record.email) return { user: null };
  const users = await readUsers(env);
  const user = users[record.email];
  return user ? { user, token } : { user: null };
}

// ============================================================
// SCRAPE DISPATCH
// ============================================================
async function scrapeAndStore(env) {
  const mode = (env.SOURCE_MODE || 'sheet').toLowerCase();
  let rows = [];
  let sourceUrl = '';
  let sourceNote = '';
  // Per-source attempt log so /api/prices/sources can show what happened.
  const attempts = [];

  if (mode === 'multi') {
    // ---------- Multi-source mode: PSA + sheet, merged ----------
    const psaResult = await safeFetchPsaFarmgate(env);
    attempts.push({ source: 'psa', ...psaResult.debug });
    const psaRows = (psaResult.rows || []).map(r => ({ ...r, source: r.source || 'psa' }));

    let sheetRows = [];
    const sheetUrl = env.GOOGLE_SHEET_CSV_URL || '';
    if (sheetUrl) {
      try {
        const text = await fetchText(sheetUrl);
        sheetRows = parseCsv(text).map(r => ({ ...r, region: r.region || 'PH', source: 'sheet' }));
        attempts.push({ source: 'sheet', ok: true, url: sheetUrl, rowCount: sheetRows.length });
      } catch (err) {
        attempts.push({ source: 'sheet', ok: false, url: sheetUrl, error: String(err && err.message || err) });
      }
    } else {
      attempts.push({ source: 'sheet', ok: false, error: 'GOOGLE_SHEET_CSV_URL not set' });
    }

    // Sheet overrides PSA on conflict, keyed by (yyyy-mm, region).
    rows = mergeRowsByKey(psaRows, sheetRows);
    sourceUrl = 'multi';
    sourceNote = `PSA OpenSTAT + Google Sheet (sheet overrides on conflict). attempts=${attempts.length}`;
  } else if (mode === 'sheet') {
    sourceUrl = env.GOOGLE_SHEET_CSV_URL || '';
    if (!sourceUrl) throw new Error('GOOGLE_SHEET_CSV_URL not set');
    const text = await fetchText(sourceUrl);
    rows = parseCsv(text);
    sourceNote = 'Google Sheet published CSV';
    attempts.push({ source: 'sheet', ok: true, url: sourceUrl, rowCount: rows.length });
  } else if (mode === 'philrice') {
    sourceUrl = env.PHILRICE_URL || 'https://www.philrice.gov.ph/price-watch/';
    const html = await fetchText(sourceUrl);
    rows = parsePhilRiceHtml(html);
    sourceNote = 'PhilRice Price Watch (HTML scrape, best-effort)';
    attempts.push({ source: 'philrice', ok: true, url: sourceUrl, rowCount: rows.length });
  } else if (mode === 'custom') {
    sourceUrl = env.CUSTOM_SOURCE_URL || '';
    if (!sourceUrl) throw new Error('CUSTOM_SOURCE_URL not set');
    const text = await fetchText(sourceUrl);
    rows = parseCsv(text);
    sourceNote = 'Custom CSV source';
    attempts.push({ source: 'custom', ok: true, url: sourceUrl, rowCount: rows.length });
  } else {
    throw new Error('Unknown SOURCE_MODE: ' + mode);
  }

  const now = new Date().toISOString();
  const data = {
    fetchedAt: now,
    source: { mode, url: sourceUrl, note: sourceNote },
    attempts,                       // diagnostic info per source attempt
    rows,
    count: rows.length,
  };
  await writeCache(env, data);
  return data;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'AbundanceFarmPriceWorker/1.0 (+https://abundance.mak-ct.com)',
      'Accept': 'text/html,application/xhtml+xml,text/csv,*/*;q=0.8',
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
  return await res.text();
}

// ============================================================
// CSV PARSER (same schema as the app's feed)
// Expected header: date,palayFresh,palayDry,cornFresh,cornDry
// ============================================================
function parseCsv(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(',').map(h => h.trim());
  const idx = (name) => header.indexOf(name);
  const di = idx('date'), pfi = idx('palayfresh'), pdi = idx('palaydry'), cfi = idx('cornfresh'), cdi = idx('corndry');
  if (di === -1) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.trim());
    const dateStr = cells[di]; if (!dateStr) continue;
    const d = new Date(dateStr.length === 10 ? dateStr + 'T12:00:00' : dateStr);
    if (isNaN(d.getTime())) continue;
    const toNum = (i) => i >= 0 && cells[i] ? (parseFloat(cells[i]) || null) : null;
    const row = {
      date: d.toISOString(),
      palayFresh: toNum(pfi), palayDry: toNum(pdi),
      cornFresh: toNum(cfi), cornDry: toNum(cdi),
    };
    if (row.palayFresh != null || row.palayDry != null || row.cornFresh != null || row.cornDry != null) out.push(row);
  }
  return out;
}

// ============================================================
// PHILRICE HTML PARSER — best-effort, customize to your target page
// ============================================================
// PhilRice publishes weekly palay farmgate prices. The site HTML structure
// changes occasionally. This parser looks for numeric values in rows
// containing "palay" / "corn" / "fresh" / "dry" keywords.
//
// If this doesn't match your target page, set SOURCE_MODE=sheet and use
// a Google Sheet instead, or set SOURCE_MODE=custom with your own CSV URL.
function parsePhilRiceHtml(html) {
  if (!html) return [];
  const stripped = html.replace(/<style[\s\S]*?<\/style>/gi, '')
                       .replace(/<script[\s\S]*?<\/script>/gi, '')
                       .replace(/\s+/g, ' ');

  // Find numeric values after price-related keywords
  const findNear = (kw) => {
    const re = new RegExp(kw + '[^0-9]{0,80}?(\\d{1,2}\\.\\d{2})', 'i');
    const m = stripped.match(re);
    return m ? parseFloat(m[1]) : null;
  };

  const palayFresh = findNear('fresh.{0,40}palay') || findNear('palay.{0,40}fresh');
  const palayDry = findNear('dry.{0,40}palay') || findNear('palay.{0,40}dry');
  const cornFresh = findNear('fresh.{0,40}corn') || findNear('corn.{0,40}fresh') || findNear('yellow corn');
  const cornDry = findNear('dry.{0,40}corn') || findNear('corn.{0,40}dry');

  if (palayFresh == null && palayDry == null && cornFresh == null && cornDry == null) return [];
  return [{
    date: new Date().toISOString(),
    palayFresh, palayDry, cornFresh, cornDry,
  }];
}

// ============================================================
// PSA OPENSTAT (PX-Web JSON API)
// ============================================================
// PSA publishes "Major Crops: Farmgate Prices, by Region, Monthly"
// through OpenSTAT (PX-Web). The API is structured JSON, much more
// reliable than HTML scraping — but PSA can change table IDs or
// dimension codes. So this module:
//   1. GETs table metadata first to discover the actual dimension codes
//   2. Builds a query selecting requested regions + last N months
//   3. POSTs and parses JSON-stat 2.0 response into our row shape
//   4. Returns rich debug info so /api/prices/sources can show what happened
//
// All URLs and codes are configurable via wrangler.toml [vars]:
//   PSA_OPENSTAT_API_BASE  PSA_PALAY_TABLE  PSA_CORN_TABLE
//   PSA_REGION_CODES       PSA_MONTHS_BACK
// ============================================================
async function safeFetchPsaFarmgate(env) {
  try {
    const result = await fetchPsaFarmgate(env);
    return { rows: result.rows || [], debug: { ok: true, ...result.debug } };
  } catch (err) {
    return { rows: [], debug: { ok: false, error: String(err && err.message || err) } };
  }
}

async function fetchPsaFarmgate(env) {
  const base = (env.PSA_OPENSTAT_API_BASE || 'https://openstat.psa.gov.ph/PXWeb/api/v1/en/DB').replace(/\/$/, '');
  const palayTable = env.PSA_PALAY_TABLE || 'DB__2M__NFG/0032M4AFN01.px';
  const cornTable = env.PSA_CORN_TABLE || 'DB__2M__NFG/0042M4ECN02.px';
  const regionCodes = (env.PSA_REGION_CODES || 'PH,00,02,R02')
    .split(',').map(s => s.trim()).filter(Boolean);
  const monthsBack = Math.max(1, Math.min(60, parseInt(env.PSA_MONTHS_BACK || '12', 10) || 12));

  const debug = { base, palayTable, cornTable, regionCodes, monthsBack, tables: [] };
  const allRows = [];

  // If palay and corn live in the same table (PSA's "Cereals" combined table),
  // fetch it once with no crop filter; label matching in pickFarmgateField
  // will route each cell to the right field. Otherwise fetch each separately.
  const fetchPlan = palayTable === cornTable
    ? [{ crops: [null], tablePath: palayTable }]
    : [{ crops: ['palay'], tablePath: palayTable }, { crops: ['corn'], tablePath: cornTable }];

  for (const { crops, tablePath } of fetchPlan) {
    const tableUrl = `${base}/${tablePath}`;
    const tableDebug = { crops: crops.map(c => c || 'auto'), tableUrl, ok: false };
    try {
      const meta = await psaFetchJson(tableUrl, null);    // GET metadata
      tableDebug.title = meta && meta.title;
      // For Geolocation we dump ALL values+labels (needed to match regions);
      // for other dimensions (Time has many entries) we keep a sample.
      tableDebug.variables = (meta && meta.variables || []).map(v => {
        const isGeo = /geo|region|location|province/i.test((v.code || '') + ' ' + (v.text || ''));
        return {
          code: v.code, text: v.text, valueCount: (v.values || []).length,
          sampleValues: isGeo ? (v.values || []) : (v.values || []).slice(0, 8),
          sampleLabels: isGeo ? (v.valueTexts || []) : (v.valueTexts || []).slice(0, 8),
        };
      });

      const query = buildPsaQuery(meta, regionCodes, monthsBack);
      tableDebug.query = query;
      if (!query) {
        tableDebug.error = 'could not build query from metadata';
        debug.tables.push(tableDebug);
        continue;
      }

      // Request CSV instead of json-stat2 — PSA's json-stat2 is buggy
      // (returns size correctly but truncates value array to length 1).
      // CSV returns the same data reliably.
      query.response = { format: 'csv' };
      const csvText = await psaFetchText(tableUrl, query);
      tableDebug.rawShape = {
        responseLen: csvText.length,
        firstLine: csvText.split('\n')[0],
        lineCount: csvText.split('\n').length,
      };

      const parsedRows = parsePsaCsv(csvText);
      tableDebug.rowCount = parsedRows.length;
      tableDebug.ok = true;
      debug.tables.push(tableDebug);
      allRows.push(...parsedRows);
    } catch (err) {
      tableDebug.error = String(err && err.message || err);
      debug.tables.push(tableDebug);
    }
  }

  // Merge multiple commodity rows that share the same (date, region) into one row.
  const merged = mergeRowsByKey(allRows, []);
  debug.totalRows = merged.length;
  return { rows: merged, debug };
}

// Build a PX-Web query body from discovered metadata.
// PSA's "Cereals: Farmgate Prices" table has 4 dimensions:
//   Geolocation (101 values: PH + regions + provinces, numeric codes)
//   Commodity   (6 values: 2 palay + 4 corn varieties)
//   Year        (annual code → label, e.g. "19" → "2009")
//   Period      (monthly code → label, e.g. "0" → "January")
// We pick regions by LABEL match (codes are just sequential ints), all
// commodities, all 12 months, and the most recent N/12 years of data.
function buildPsaQuery(meta, regionCodes, monthsBack) {
  if (!meta || !Array.isArray(meta.variables)) return null;
  const vars = meta.variables;

  const findVar = (patterns) => vars.find(v => {
    const hay = ((v.code || '') + ' ' + (v.text || '')).toLowerCase();
    return patterns.some(p => hay.includes(p));
  });
  const geoVar = findVar(['geo', 'region', 'location', 'province']);
  const yearVar = findVar(['year']);
  const periodVar = findVar(['period', 'month']);
  const commodityVar = findVar(['commodity', 'crop']);

  if (!geoVar || !yearVar) return null;
  // periodVar is optional — some tables have just Year (annual data)

  // ---- Region matching ----
  // Codes are just sequential numbers, so we MUST match by label substring.
  // We map our user-friendly codes (PH/02 etc.) to known PSA label patterns.
  const codes = (geoVar.values || []);
  const labels = (geoVar.valueTexts || []);
  const labelMap = {
    'PH': /^philippines\b/i,
    '00': /^philippines\b/i,
    '0':  /^philippines\b/i,
    'R02': /region ii\b|cagayan valley/i,
    '02': /region ii\b|cagayan valley/i,
    '2':  /region ii\b|cagayan valley/i,
  };
  const wantedRegions = [];
  for (const want of regionCodes) {
    const wantU = want.toUpperCase();
    // First: exact code match (some tables do use 'PH00' style)
    let hit = codes.find(c => (c || '').toUpperCase() === wantU);
    // Then: label match using our region map
    if (!hit && labelMap[wantU]) {
      const re = labelMap[wantU];
      const idx = labels.findIndex(l => re.test(l || ''));
      if (idx >= 0) hit = codes[idx];
    }
    if (hit && !wantedRegions.includes(hit)) wantedRegions.push(hit);
  }
  if (wantedRegions.length === 0) return null;

  // ---- Year selection ----
  // monthsBack of 12 = 1 year, 24 = 2 years, etc. Always pull at least 2 years
  // so we have something to fall back on when the current month hasn't been
  // published yet.
  const yearsBack = Math.max(2, Math.ceil(monthsBack / 12));
  const yearValues = (yearVar.values || []).slice(-yearsBack);

  const query = [
    { code: geoVar.code, selection: { filter: 'item', values: wantedRegions } },
    { code: yearVar.code, selection: { filter: 'item', values: yearValues } },
  ];

  // Period: select Jan-Dec (skip annual aggregate if present, usually last entry)
  if (periodVar) {
    // PSA's Period dim has 13 values: Jan-Dec + sometimes "Annual" at the end.
    // We want all 12 months. If valueCount > 12, take the first 12 (months).
    const periodValues = (periodVar.values || []).slice(0, Math.min(12, periodVar.values.length));
    query.push({ code: periodVar.code, selection: { filter: 'item', values: periodValues } });
  }

  // Commodity: select ALL (palay + corn varieties); parser will route to fields.
  if (commodityVar) {
    query.push({ code: commodityVar.code, selection: { filter: 'item', values: (commodityVar.values || []) } });
  }

  return { query, response: { format: 'json-stat2' } };
}

// Helper: GET (no body) returns metadata JSON; POST returns data JSON.
async function psaFetchJson(url, body) {
  const init = {
    method: body ? 'POST' : 'GET',
    headers: {
      'User-Agent': 'AbundanceFarmPriceWorker/1.0 (+https://abundance.mak-ct.com)',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    cf: { cacheTtl: 1800, cacheEverything: true },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) throw new Error('PSA HTTP ' + res.status + ' from ' + url);
  return await res.json();
}

// Helper: POST a query and return the raw response as text (used for CSV).
async function psaFetchText(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'AbundanceFarmPriceWorker/1.0 (+https://abundance.mak-ct.com)',
      'Accept': 'text/csv, text/plain, */*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cf: { cacheTtl: 1800, cacheEverything: true },
  });
  if (!res.ok) throw new Error('PSA HTTP ' + res.status + ' from ' + url);
  return await res.text();
}

// Parse PX-Web CSV output.
// Header: "Geolocation","Commodity","2025 January","2025 February",...
// Body:   "PHILIPPINES","Palay [Paddy] ...",20.72,20.36,...
// Missing values come back as ".." (two dots).
function parsePsaCsv(csvText) {
  if (!csvText) return [];
  // Strip optional BOM
  const text = csvText.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headerCells = parseCsvRow(lines[0]);
  // First two columns are Geolocation, Commodity. Remaining are date columns.
  if (headerCells.length < 3) return [];
  const dateColumns = headerCells.slice(2).map(h => parsePsaDateHeader(h));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i]);
    if (cells.length < 3) continue;
    const regionLabel = cells[0];
    const commodityLabel = cells[1];
    const region = normalizePsaRegion('', regionLabel);
    const field = pickFarmgateField(null, commodityLabel, '');
    if (!field) continue;

    for (let j = 0; j < dateColumns.length; j++) {
      const date = dateColumns[j];
      if (!date) continue;
      const raw = cells[2 + j];
      if (raw == null) continue;
      const trimmed = String(raw).trim();
      if (!trimmed || trimmed === '..' || trimmed === '-') continue;
      const num = parseFloat(trimmed);
      if (!isFinite(num) || num <= 0) continue;

      rows.push({
        date,
        region,
        source: 'psa',
        [field]: num,
        meta: {
          psaRegion: regionLabel,
          psaCommodity: commodityLabel,
        },
      });
    }
  }
  return rows;
}

// Parse a single CSV row, handling double-quoted fields and embedded commas.
function parseCsvRow(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// PSA CSV date columns look like "2025 January" or "2026 April".
function parsePsaDateHeader(header) {
  if (!header) return null;
  const m = String(header).trim().match(/(\d{4})\s+(\w+)/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const monthIdx = MONTH_NAMES.indexOf(m[2].toLowerCase());
  if (monthIdx < 0) return null;
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}-01T00:00:00Z`;
}

// Parse JSON-stat 2.0 dataset into our row shape.
// Each "value" in the flat array corresponds to a coordinate vector across
// the dimensions in `id`. We walk every cell, pull out date/region/commodity,
// and emit rows tagged by region + source.
function parsePsaJsonStat(ds, cropHint) {
  if (!ds || !Array.isArray(ds.id) || !Array.isArray(ds.size) || !Array.isArray(ds.value)) return [];
  const ids = ds.id;
  const sizes = ds.size;
  const dims = ds.dimension || {};

  // Pre-compute index→code arrays for each dimension.
  const dimCodes = ids.map(id => {
    const dim = dims[id] || {};
    const cat = dim.category || {};
    const indexMap = cat.index || {};
    if (Array.isArray(indexMap)) return indexMap.slice();
    // indexMap is { code: position }; invert it.
    const arr = new Array(Object.keys(indexMap).length);
    for (const code of Object.keys(indexMap)) arr[indexMap[code]] = code;
    return arr;
  });
  const dimLabels = ids.map((id, di) => {
    const dim = dims[id] || {};
    const cat = dim.category || {};
    const labelMap = cat.label || {};
    return dimCodes[di].map(c => labelMap[c] || c);
  });

  // Locate which dimension is geo / year / period / commodity.
  // PSA splits time into Year + Period dimensions. Other tables may
  // have a single Time dimension — handle both.
  const findIdx = (patterns) => {
    for (let i = 0; i < ids.length; i++) {
      const hay = (ids[i] || '').toLowerCase();
      if (patterns.some(p => hay.includes(p))) return i;
    }
    return -1;
  };
  const gIdx = findIdx(['geo', 'region', 'location', 'province']);
  const yIdx = findIdx(['year']);
  const pIdx = findIdx(['period', 'month']);
  const tIdx = (yIdx === -1 && pIdx === -1) ? findIdx(['time']) : -1;
  const cIdx = findIdx(['commodity', 'crop']);

  if (gIdx === -1) return [];
  if (yIdx === -1 && tIdx === -1) return [];

  const rows = [];
  // Strides for converting linear value index → coordinate vector.
  const strides = new Array(sizes.length);
  let stride = 1;
  for (let i = sizes.length - 1; i >= 0; i--) {
    strides[i] = stride;
    stride *= sizes[i];
  }

  for (let i = 0; i < ds.value.length; i++) {
    const v = ds.value[i];
    if (v == null) continue;
    const num = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(num)) continue;
    // Walk coordinates
    const coords = new Array(sizes.length);
    let r = i;
    for (let j = 0; j < sizes.length; j++) {
      coords[j] = Math.floor(r / strides[j]);
      r = r % strides[j];
    }
    const regionCode = dimCodes[gIdx][coords[gIdx]];
    const commodityCode = cIdx >= 0 ? dimCodes[cIdx][coords[cIdx]] : '';
    const commodityLabel = cIdx >= 0 ? dimLabels[cIdx][coords[cIdx]] : '';

    // Construct date from Year + Period (PSA) or single Time dim (other tables).
    let date = null;
    if (yIdx >= 0) {
      const yearLabel = dimLabels[yIdx][coords[yIdx]];     // "2020"
      const periodLabel = pIdx >= 0 ? dimLabels[pIdx][coords[pIdx]] : '';
      date = psaYearPeriodToIso(yearLabel, periodLabel);
    } else if (tIdx >= 0) {
      const timeCode = dimCodes[tIdx][coords[tIdx]];
      date = psaTimeToIso(timeCode);
    }
    if (!date) continue;

    const region = normalizePsaRegion(regionCode, dimLabels[gIdx][coords[gIdx]]);
    const field = pickFarmgateField(cropHint, commodityLabel, commodityCode);
    if (!field) continue;

    rows.push({
      date,
      region,
      source: 'psa',
      [field]: num,
      meta: {
        psaRegion: regionCode,
        psaCommodity: commodityCode,
        psaDate: date.slice(0, 7),
      },
    });
  }
  return rows;
}

// Map a PSA region code/label to our compact code: "PH" national, "02" Cagayan Valley.
function normalizePsaRegion(code, label) {
  const c = (code || '').toUpperCase();
  const l = (label || '').toLowerCase();
  if (c === 'PH' || c === 'PH00' || c === '00' || l.includes('philippines') || l.includes('national')) return 'PH';
  if (c === 'R02' || c === '02' || c.endsWith('02') || l.includes('cagayan valley') || l.includes('region ii') || l.includes('region 2')) return '02';
  return c || 'PH';
}

// Decide which schema field this PSA row maps to.
// PSA's "Cereals" commodity dimension uses these labels:
//   "Palay [Paddy] Fancy, dry (conv. to 14% mc)"          → palayDry
//   "Palay [Paddy] Other Variety, dry (conv. to 14% mc)"  → palayDry
//   "Corngrain [Maize] Yellow, matured"                    → cornDry  (matured = dry)
//   "Corngrain [Maize] White, matured"                     → cornDry
//   "Green Corn (Maize, green), White"                     → cornFresh (green = fresh)
//   "Green Corn (Maize, green), Yellow"                    → cornFresh
// PSA has NO "palay fresh" — they only publish dry palay (14% mc standard).
function pickFarmgateField(cropHint, commodityLabel, commodityCode) {
  const hay = ((commodityLabel || '') + ' ' + (commodityCode || '')).toLowerCase();
  const isPalay = /palay|paddy|rice/.test(hay);
  const isCorn  = /\bcorn\b|maize|corngrain/.test(hay);
  // "matured" = dry corn; "green" corn = fresh (still on cob or pre-dry)
  const isFresh = /\bfresh\b|\bwet\b|\bgreen\b/.test(hay);
  const isDry   = /\bdry\b|dried|\bmatured\b|14%\s*mc/.test(hay);

  if (cropHint === 'palay') {
    if (!isPalay) return null;
    return isFresh ? 'palayFresh' : 'palayDry';
  }
  if (cropHint === 'corn') {
    if (!isCorn) return null;
    return isFresh ? 'cornFresh' : 'cornDry';
  }
  if (isPalay) return isFresh ? 'palayFresh' : 'palayDry';
  if (isCorn)  return isFresh ? 'cornFresh'  : 'cornDry';
  return null;
}

// Build an ISO date from PSA's Year label + Period label.
// Year label is "2020" etc.; Period label is "January".."December".
// If period is missing or unrecognizable (e.g. "Annual"), default to mid-year.
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
function psaYearPeriodToIso(yearLabel, periodLabel) {
  const ym = String(yearLabel || '').match(/(\d{4})/);
  if (!ym) return null;
  const year = parseInt(ym[1], 10);
  let monthIdx = 6;   // default to July (mid-year) for annual rows
  if (periodLabel) {
    const pl = String(periodLabel).toLowerCase().trim();
    const idx = MONTH_NAMES.indexOf(pl);
    if (idx >= 0) monthIdx = idx + 1;
    else if (/^q[1-4]$/i.test(pl)) monthIdx = (parseInt(pl[1], 10) - 1) * 3 + 1;
    else if (/annual|total/i.test(pl)) monthIdx = 6;
  }
  const mm = String(monthIdx).padStart(2, '0');
  return `${year}-${mm}-01T00:00:00Z`;
}

// Convert a PX-Web time code into an ISO date.
// Common shapes: "2026M04", "2026-04", "2026", "2026Q1".
function psaTimeToIso(code) {
  if (!code) return null;
  const s = String(code).trim();
  let m = s.match(/^(\d{4})M(\d{1,2})$/i);
  if (m) return new Date(`${m[1]}-${String(m[2]).padStart(2,'0')}-01T00:00:00Z`).toISOString();
  m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (m) {
    const day = m[3] ? String(m[3]).padStart(2,'0') : '01';
    return new Date(`${m[1]}-${String(m[2]).padStart(2,'0')}-${day}T00:00:00Z`).toISOString();
  }
  m = s.match(/^(\d{4})Q(\d)$/i);
  if (m) {
    const startMonth = (parseInt(m[2], 10) - 1) * 3 + 1;
    return new Date(`${m[1]}-${String(startMonth).padStart(2,'0')}-01T00:00:00Z`).toISOString();
  }
  m = s.match(/^(\d{4})$/);
  if (m) return new Date(`${m[1]}-01-01T00:00:00Z`).toISOString();
  // Last resort: let Date parse it
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ============================================================
// MERGE ROWS — sheet wins over PSA on conflicts
// ============================================================
// Design:
//   - PSA returns monthly aggregates: one row per region per month, with palay
//     and corn dimensions coming back as separate rows that share the same
//     (yyyy-mm, region) key. We merge those into one PSA row per key.
//   - Sheet rows are user-entered, can have multiple per month (per-day or
//     per-week). We must NOT collapse them — that would destroy the signal
//     density used by the rolling-average and trend calculations.
//   - Where sheet has any row for a given (yyyy-mm, region), the corresponding
//     PSA monthly aggregate is suppressed (sheet wins on conflict).
function mergeRowsByKey(psaRows, sheetRows) {
  const sheetKeySet = new Set();
  for (const r of (sheetRows || [])) {
    if (!r || !r.date) continue;
    const ym = String(r.date).slice(0, 7);   // "YYYY-MM"
    const region = r.region || 'PH';
    sheetKeySet.add(`${ym}|${region}`);
  }

  // Aggregate PSA rows by (yyyy-mm, region) so palay+corn fields from the
  // same month/region collapse into a single row.
  const psaMap = new Map();
  for (const r of (psaRows || [])) {
    if (!r || !r.date) continue;
    const ym = String(r.date).slice(0, 7);
    const region = r.region || 'PH';
    const key = `${ym}|${region}`;
    if (sheetKeySet.has(key)) continue;          // suppressed by sheet
    const prev = psaMap.get(key) || { date: r.date, region, source: r.source || 'psa' };
    const out = { ...prev };
    ['palayFresh','palayDry','cornFresh','cornDry'].forEach(f => {
      if (r[f] != null) out[f] = r[f];
    });
    if (r.meta) out.meta = { ...(prev.meta || {}), ...r.meta };
    psaMap.set(key, out);
  }

  // Sheet rows pass through unchanged — keep their original granularity.
  const combined = [...psaMap.values(), ...(sheetRows || [])];

  return combined.sort((a, b) => {
    const d = new Date(b.date) - new Date(a.date);
    if (d !== 0) return d;
    return (a.region || '').localeCompare(b.region || '');
  });
}
