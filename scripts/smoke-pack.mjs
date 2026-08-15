// The tarball smoke test: `npm pack` the real artifact, install it into
// a scratch project, and deliver one signed webhook end-to-end against
// a real Postgres (DATABASE_URL) — proof the SHIPPED package works, not
// just the repo. Run: DATABASE_URL=postgres://… node scripts/smoke-pack.mjs
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('smoke-pack: DATABASE_URL is required');
  process.exit(1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });
const capture = (cmd, cwd = root) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();

// 1. Pack the artifact (prepack builds dist).
const tarball = resolve(root, capture('npm pack --silent').split('\n').pop());
console.log(`smoke-pack: tarball ${tarball}`);

// 2. Scratch project with ONLY the tarball + pg (the peer we ask hosts for).
const scratch = mkdtempSync(join(tmpdir(), 'harkara-smoke-'));
try {
  run('npm init -y', scratch);
  run(`npm install --no-audit --no-fund "${tarball}" pg`, scratch);

  // 3. The host app, as a file — nothing imported from the repo.
  writeFileSync(
    join(scratch, 'smoke.mjs'),
    `
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createHarkara, runMigrations } from 'harkara';

const adminUrl = process.env.DATABASE_URL;
const SMOKE_DB = 'harkara_smoke';

// Fresh database so the smoke run never touches anyone's ledger.
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query('DROP DATABASE IF EXISTS ' + SMOKE_DB);
await admin.query('CREATE DATABASE ' + SMOKE_DB);
await admin.end();
const url = new URL(adminUrl);
url.pathname = '/' + SMOKE_DB;
const databaseUrl = url.toString();

const applied = await runMigrations({ databaseUrl });
console.log('smoke: migrations applied:', applied.length);

const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ id: req.headers['webhook-id'], sig: req.headers['webhook-signature'], body });
    res.statusCode = 200;
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const receiverUrl = 'http://127.0.0.1:' + server.address().port + '/hook';

const pool = new pg.Pool({ connectionString: databaseUrl });
const { rows } = await pool.query(
  "INSERT INTO endpoints (url, event_types) VALUES ($1, '{}') RETURNING id",
  [receiverUrl],
);
await pool.query('INSERT INTO endpoint_secrets (endpoint_id, secret) VALUES ($1, $2)', [
  rows[0].id,
  'whsec_' + randomBytes(24).toString('base64'),
]);

const harkara = createHarkara({ pool });
const { messageId } = await harkara.send({ type: 'smoke.test', payload: { ok: true } });
const worker = harkara.startWorker({
  pollIntervalMs: 50,
  ssrf: { allowInsecureHttp: true, allowPrivateAddresses: true },
});

const deadline = Date.now() + 60_000;
for (;;) {
  const { rows: d } = await pool.query(
    "SELECT count(*)::int AS n FROM deliveries WHERE status = 'delivered'",
  );
  if (d[0].n === 1) break;
  if (Date.now() > deadline) throw new Error('smoke: delivery did not complete in 60s');
  await new Promise((r) => setTimeout(r, 200));
}
await worker.stop();
server.close();
await pool.end();

if (received.length !== 1) throw new Error('smoke: expected exactly 1 request');
if (received[0].id !== messageId) throw new Error('smoke: webhook-id mismatch');
if (!String(received[0].sig).startsWith('v1,')) throw new Error('smoke: missing v1 signature');
console.log('smoke: OK — one signed webhook delivered through the packed tarball');
`,
  );
  // The bin must work from a real install too: banner, version, and a
  // refusal (no DATABASE_URL flag/env here would still exit 0 for help).
  run('npx --no-install harkara version', scratch);
  run('npx --no-install harkara help', scratch);
  run('node smoke.mjs', scratch);
} finally {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(tarball, { force: true });
}
console.log('smoke-pack: PASS');
