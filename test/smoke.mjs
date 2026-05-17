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
check('me on empty system reports userCount 0', r.status === 200 && r.json && r.json.userCount === 0);

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
