'use strict';
/*
 * Tiny JSON-file store. Fine for launch volume (hundreds–thousands of keys).
 * Swap for SQLite/Postgres later — the rest of the server only uses this API.
 */
const fs = require('node:fs');
const path = require('node:path');

const os = require('node:os');

function getFilePath() {
  if (process.env.TL_DATA_FILE) return process.env.TL_DATA_FILE;
  if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY || process.env.VERCEL) {
    return path.join(os.tmpdir(), 'trade-lock-data.json');
  }
  return path.join(__dirname, 'data.json');
}

function load() {
  try {
    const file = getFilePath();
    if (!fs.existsSync(file)) {
      // If running in serverless and local data.json exists in package, seed from it
      const bundled = path.join(__dirname, 'data.json');
      if (fs.existsSync(bundled)) {
        const raw = fs.readFileSync(bundled, 'utf8');
        return JSON.parse(raw);
      }
    }
    const raw = fs.readFileSync(file, 'utf8');
    const d = JSON.parse(raw);
    if (!d.licenses || !d.orders) throw new Error('bad shape');
    if (!d.processedWebhooks) d.processedWebhooks = {};
    return d;
  } catch (e) {
    return { licenses: {}, orders: {}, processedWebhooks: {} }; // hash -> license, orderId -> order
  }
}

let data = load();
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const file = getFilePath();
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.warn('[store] Local disk write skipped:', e.message);
    }
  }, 25);
}

function saveSync() {
  clearTimeout(saveTimer);
  try {
    const file = getFilePath();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('[store] Local disk writeSync skipped:', e.message);
  }
}

module.exports = {
  get licenses() { return data.licenses; },
  get orders() { return data.orders; },
  get processedWebhooks() {
    if (!data.processedWebhooks) data.processedWebhooks = {};
    return data.processedWebhooks;
  },
  save,
  saveSync,
  reload() { data = load(); },
};
