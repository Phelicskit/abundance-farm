// Offline smoke test. Drives the Worker fetch handler with a fake KV binding.
// Run with: npm test
import worker from '../src/index.js';

class FakeKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, String(v)); }
  async delete(k) { this.store.delete(k); }
}

const env = {
  PRICES: new FakeKV(),
  ADMIN_SECRET: 'fake-admin-secret-for-test',
  ASSETS: { fetch: () => new Response('static-asset', { status: 200 }) },
};

const failed = [];
function check(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) failed.push(label);
}

async function call(method, path, { body, headers } = {}) {
  const init = { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await worker.fetch(new Request('https://test.local' + path, init), env, {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

let r;

r = await call('GET', '/');
check('static asset fall-through', r.status === 200 && r.text === 'static-asset');

r = await call('GET', '/api/me');
check('me on empty system says needsBootstrap=true', r.status === 200 && r.json && r.json.needsBootstrap === true);
check('me on empty system does NOT leak userCount', r.status === 200 && r.json && r.json.userCount === undefined);

r = await call('POST', '/api/users', {
  body: { email: 'kit@example.com', name: 'Kit', password: 'password123', role: 'owner' },
  headers: { 'X-Admin-Secret': env.ADMIN_SECRET },
});
check('first owner bootstrap', r.status === 200 && r.json.user.email === 'kit@example.com');

r = await call('POST', '/api/login', { body: { email: 'kit@example.com', password: 'password123' } });
check('owner login succeeds', r.status === 200 && r.json && r.json.token);
const ownerToken = r.json && r.json.token;

r = await call('POST', '/api/login', { body: { email: 'kit@example.com', password: 'wrong' } });
check('wrong password rejected', r.status === 401);

r = await call('POST', '/api/users', {
  body: { email: 'manager@example.com', name: 'Lito', password: 'manager-pass', role: 'manager' },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('owner creates manager', r.status === 200 && r.json.user.role === 'manager');

r = await call('POST', '/api/login', { body: { email: 'manager@example.com', password: 'manager-pass' } });
check('manager login succeeds', r.status === 200 && r.json && r.json.token);
const mgrToken = r.json && r.json.token;

r = await call('POST', '/api/log', {
  body: { date: '2026-05-08', palayFresh: 18.5 },
  headers: { Authorization: 'Bearer ' + mgrToken },
});
check('manager logs price; author tagged', r.status === 200 && r.json.entry.author === 'manager@example.com');
const mgrEntry = r.json.entry.id;

r = await call('POST', '/api/log', {
  body: { date: '2026-05-08', cornFresh: 16.5 },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
const ownerEntry = r.json.entry.id;

r = await call('DELETE', '/api/log/' + ownerEntry, { headers: { Authorization: 'Bearer ' + mgrToken } });
check('manager forbidden from owner-authored entry', r.status === 403);

r = await call('DELETE', '/api/log/' + mgrEntry, { headers: { Authorization: 'Bearer ' + mgrToken } });
check('manager can delete own entry', r.status === 200);

r = await call('DELETE', '/api/log/' + ownerEntry, { headers: { Authorization: 'Bearer ' + ownerToken } });
check('owner can delete any entry', r.status === 200);

r = await call('GET', '/api/users', { headers: { Authorization: 'Bearer ' + mgrToken } });
check('manager forbidden from user list', r.status === 403);

r = await call('GET', '/api/users', { headers: { Authorization: 'Bearer ' + ownerToken } });
check('owner sees user list', r.status === 200 && r.json.users.length === 2);

r = await call('PUT', '/api/users/kit@example.com', {
  body: { role: 'manager' },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('cannot demote only owner', r.status === 400);

r = await call('DELETE', '/api/users/kit@example.com', { headers: { Authorization: 'Bearer ' + ownerToken } });
check('cannot delete self', r.status === 400);

// ----- /api/ops -----
r = await call('GET', '/api/ops');
check('ops requires auth', r.status === 401);

r = await call('GET', '/api/ops', { headers: { Authorization: 'Bearer ' + mgrToken } });
check('manager can read ops (initially empty)', r.status === 200 && r.json && r.json.ops && Object.keys(r.json.ops).length === 0);

r = await call('PATCH', '/api/ops', {
  body: { 'rfops-areas': [{ id:1, name:'Bunkhouse' }], 'rfops-harvestLogs': [{ id:'h1', bags:50 }] },
  headers: { Authorization: 'Bearer ' + mgrToken },
});
check('manager can patch ops', r.status === 200 && r.json.ok);

r = await call('GET', '/api/ops', { headers: { Authorization: 'Bearer ' + ownerToken } });
check('owner reads same ops; updatedBy is the manager', r.status === 200
  && r.json.ops['rfops-areas'].length === 1
  && r.json.ops['rfops-harvestLogs'].length === 1
  && r.json.updatedBy === 'manager@example.com');

// PATCH a different key — should NOT drop the existing keys
r = await call('PATCH', '/api/ops', {
  body: { 'rfops-equipment': [{ id:'e1', name:'Tractor' }] },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('owner can patch ops', r.status === 200);

r = await call('GET', '/api/ops', { headers: { Authorization: 'Bearer ' + ownerToken } });
check('partial patch preserves other keys', r.status === 200
  && r.json.ops['rfops-areas'].length === 1
  && r.json.ops['rfops-harvestLogs'].length === 1
  && r.json.ops['rfops-equipment'][0].name === 'Tractor');

// Internal _-prefixed keys cannot be set by clients
r = await call('PATCH', '/api/ops', {
  body: { '_updatedBy': 'attacker@example.com' },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('client cannot tamper with _ keys', r.status === 200);
r = await call('GET', '/api/ops', { headers: { Authorization: 'Bearer ' + ownerToken } });
check('updatedBy still server-assigned after tamper attempt', r.json.updatedBy === 'kit@example.com');

// PUT (full replace) is owner-only
r = await call('PUT', '/api/ops', {
  body: { 'rfops-areas': [] },
  headers: { Authorization: 'Bearer ' + mgrToken },
});
check('manager forbidden from PUT replace', r.status === 403);

r = await call('PUT', '/api/ops', {
  body: { 'rfops-areas': [{ id:99 }] },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('owner can PUT replace', r.status === 200);
r = await call('GET', '/api/ops', { headers: { Authorization: 'Bearer ' + ownerToken } });
check('PUT replaces wholesale (other keys gone)', r.json.ops['rfops-equipment'] === undefined && r.json.ops['rfops-areas'][0].id === 99);

// ============================================================
// NDVI ENDPOINTS — /api/ndvi-history + /api/ndvi-snapshot
// ============================================================
// Real Sentinel Hub calls aren't exercised here (would need network +
// SENTINEL_HUB_INSTANCE_ID). We verify auth gating, input validation,
// 503 when Sentinel Hub isn't configured, and KV cache-hit behavior
// (which doesn't need to call Sentinel Hub at all).

const validPolygon = [[16.81, 121.71], [16.81, 121.72], [16.82, 121.72], [16.82, 121.71]];

// /api/ndvi-history — auth gate
r = await call('POST', '/api/ndvi-history', {
  body: { polygon: validPolygon, fromDate: '2025-01-01', toDate: '2025-12-31' },
});
check('ndvi-history requires auth', r.status === 401);

// /api/ndvi-history — 503 when SENTINEL_HUB_INSTANCE_ID not set
r = await call('POST', '/api/ndvi-history', {
  body: { polygon: validPolygon, fromDate: '2025-01-01', toDate: '2025-12-31' },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-history 503 when Sentinel Hub not configured', r.status === 503);

// Now set SENTINEL_HUB_INSTANCE_ID so validation paths can be exercised
env.SENTINEL_HUB_INSTANCE_ID = 'fake-instance-id-for-test';

// /api/ndvi-history — input validation (polygon required + has ≥3 vertices)
r = await call('POST', '/api/ndvi-history', {
  body: { fromDate: '2025-01-01' },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-history 400 when polygon missing', r.status === 400);

r = await call('POST', '/api/ndvi-history', {
  body: { polygon: [[1,2],[3,4]], fromDate: '2025-01-01' },  // only 2 vertices
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-history 400 when polygon has <3 vertices', r.status === 400);

r = await call('POST', '/api/ndvi-history', {
  body: { polygon: validPolygon },  // missing fromDate
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-history 400 when fromDate missing', r.status === 400);

// /api/ndvi-snapshot — auth gate
r = await call('POST', '/api/ndvi-snapshot', {
  body: { areaId: 1, polygon: validPolygon, date: '2025-05-21' },
});
check('ndvi-snapshot requires auth', r.status === 401);

// /api/ndvi-snapshot — 503 when SENTINEL_HUB not set
delete env.SENTINEL_HUB_INSTANCE_ID;
r = await call('POST', '/api/ndvi-snapshot', {
  body: { areaId: 1, polygon: validPolygon, date: '2025-05-21' },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-snapshot 503 when Sentinel Hub not configured', r.status === 503);
env.SENTINEL_HUB_INSTANCE_ID = 'fake-instance-id-for-test';

// /api/ndvi-snapshot — input validation
r = await call('POST', '/api/ndvi-snapshot', {
  body: { areaId: 1, date: '2025-05-21' },  // missing polygon
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-snapshot 400 when polygon missing', r.status === 400);

r = await call('POST', '/api/ndvi-snapshot', {
  body: { polygon: validPolygon, date: '2025-05-21' },  // missing areaId
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-snapshot 400 when areaId missing', r.status === 400);

r = await call('POST', '/api/ndvi-snapshot', {
  body: { areaId: 1, polygon: validPolygon },  // missing date
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-snapshot 400 when date missing', r.status === 400);

// /api/ndvi-snapshot — KV cache HIT path. Pre-populate a cache entry; the
// endpoint should return the cached image without calling Sentinel Hub.
const cacheKey = 'ndvi-cache:42:2025-05-21:512';
const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';
await env.PRICES.put(cacheKey, fakeDataUrl);

r = await call('POST', '/api/ndvi-snapshot', {
  body: { areaId: 42, polygon: validPolygon, date: '2025-05-21', width: 512 },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-snapshot returns cached image on cache hit', r.status === 200 && r.json && r.json.image === fakeDataUrl && r.json.cached === true);

// Different width → different cache key → cache MISS
r = await call('POST', '/api/ndvi-snapshot', {
  body: { areaId: 42, polygon: validPolygon, date: '2025-05-21', width: 256 },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
// We expect a 502 (WMS call attempt fails on the fake instance ID) — that
// proves we MISSED the cache and tried to fetch live, which is correct.
check('ndvi-snapshot cache key includes width (miss when width differs)', r.status === 502);

// Different areaId → different cache key → cache MISS
r = await call('POST', '/api/ndvi-snapshot', {
  body: { areaId: 99, polygon: validPolygon, date: '2025-05-21', width: 512 },
  headers: { Authorization: 'Bearer ' + ownerToken },
});
check('ndvi-snapshot cache key includes areaId (miss when area differs)', r.status === 502);

// Clean up so the SENTINEL_HUB var doesn't leak into following tests
delete env.SENTINEL_HUB_INSTANCE_ID;

// ----- logout (kept last) -----
r = await call('POST', '/api/logout', { headers: { Authorization: 'Bearer ' + mgrToken } });
check('logout succeeds', r.status === 200);

r = await call('GET', '/api/me', { headers: { Authorization: 'Bearer ' + mgrToken } });
check('manager token rejected after logout', r.status === 200 && r.json && r.json.user === null);

if (failed.length) {
  console.log('\n' + failed.length + ' check(s) failed.');
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
