'use strict';
/* Minimal .env loader (no dependencies). Real environment variables win. */
const fs = require('node:fs');
const path = require('node:path');

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const key = s.slice(0, i).trim();
    let val = s.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function loadEnvFile(file) {
  const f = file || path.join(__dirname, '.env');
  try {
    const parsed = parseEnv(fs.readFileSync(f, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return Object.keys(parsed);
  } catch (e) {
    return []; // no .env — environment-only configuration is fine
  }
}

module.exports = { parseEnv, loadEnvFile };
