'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
function cleanEnvironment(file) {
  const env = { ...process.env, TL_DATA_FILE: file };
  for (const key of ['VERCEL', 'NETLIFY', 'AWS_LAMBDA_FUNCTION_NAME']) delete env[key];
  return env;
}

test('file store fails visibly on corruption and writes atomically with private permissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trade-lock-store-'));
  const file = path.join(dir, 'nested', 'data.json');
  try {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '{not-json');
    const broken = spawnSync(process.execPath, ['-e', "require('./server/store')"], {
      cwd: root, env: cleanEnvironment(file), encoding: 'utf8'
    });
    assert.notStrictEqual(broken.status, 0);
    assert.match(broken.stderr, /data store could not be loaded/);

    fs.rmSync(file);
    const saved = spawnSync(process.execPath, ['-e',
      "const s=require('./server/store');s.orders.order_test={order_id:'order_test'};s.saveSync();"
    ], { cwd: root, env: cleanEnvironment(file), encoding: 'utf8' });
    assert.strictEqual(saved.status, 0, saved.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).orders.order_test.order_id, 'order_test');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQL functions preserve payment identity and recheck license state under row locks', () => {
  const sql = fs.readFileSync(path.join(root, 'server/schema.sql'), 'utf8');
  assert.match(sql, /WHERE order_id = p_order_id FOR UPDATE/);
  assert.match(sql, /existing_payment <> p_payment_id/);
  assert.match(sql, /SELECT hash INTO result_hash FROM public\.licenses WHERE order_id = p_order_id/);
  assert.match(sql, /FROM public\.licenses WHERE hash = p_hash FOR UPDATE/);
  assert.match(sql, /current_revoked OR \(current_expires IS NOT NULL AND current_expires <= now\(\)\)/);
  assert.match(sql, /'reason', 'inactive'/);
});
