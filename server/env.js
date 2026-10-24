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
  const loaded = [];
  const f = file || path.join(__dirname, '.env');
  try {
    if (fs.existsSync(f)) {
      const parsed = parseEnv(fs.readFileSync(f, 'utf8'));
      for (const [k, v] of Object.entries(parsed)) {
        if ((process.env[k] === undefined || process.env[k] === '') && v !== '') {
          process.env[k] = v;
          loaded.push(k);
        }
      }
    }
  } catch (e) {
    // Ignore read errors
  }

  // Also check global_api_keys.env fallback (Rule 15)
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const globalEnv = path.join(home, '.gemini', 'config', 'global_api_keys.env');
    if (fs.existsSync(globalEnv)) {
      const parsedGlobal = parseEnv(fs.readFileSync(globalEnv, 'utf8'));
      for (const [k, v] of Object.entries(parsedGlobal)) {
        if ((process.env[k] === undefined || process.env[k] === '') && v !== '') {
          process.env[k] = v;
          if (!loaded.includes(k)) loaded.push(k);
        }
      }
    }
  } catch (e) {
    // Ignore global env read errors
  }

  return loaded;
}

module.exports = { parseEnv, loadEnvFile };
