'use strict';
/*
 * Single-process JSON-file store for development and small self-hosted deployments.
 * Use the Supabase adapter for serverless or multi-instance production deployments.
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

function emptyStore() { return { licenses: {}, orders: {}, processedWebhooks: {}, paymentHistory: {} }; }

function load() {
  const file = getFilePath();
  // Never seed a shared serverless /tmp store from bundled customer data.
  if (!fs.existsSync(file)) return emptyStore();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const d = JSON.parse(raw);
    if (!d.licenses || !d.orders) throw new Error('bad shape');
    if (!d.processedWebhooks) d.processedWebhooks = {};
    if (!d.paymentHistory) d.paymentHistory = {};
    return d;
  } catch (e) {
    if (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY || process.env.VERCEL) {
      console.error('[store] Ignoring unreadable ephemeral cache; remote durable state remains authoritative.');
      return emptyStore();
    }
    // A corrupt file-only customer database must not look like an empty one.
    throw new Error('Trade Lock data store could not be loaded from ' + file + ': ' + e.message);
  }
}

let data = load();

// Retain the old API name without retaining its silent, delayed-write behavior.
function save() { return saveSync(); }

function saveSync() {
  try {
    const file = getFilePath();
    const tmp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('[store] Critical local disk write failed:', e.message);
    throw e;
  }
  return true;
}

module.exports = {
  get licenses() { return data.licenses; },
  get orders() { return data.orders; },
  get processedWebhooks() {
    if (!data.processedWebhooks) data.processedWebhooks = {};
    return data.processedWebhooks;
  },
  get paymentHistory() {
    if (!data.paymentHistory) data.paymentHistory = {};
    return data.paymentHistory;
  },
  save,
  saveSync,
  reload() { data = load(); },
};
