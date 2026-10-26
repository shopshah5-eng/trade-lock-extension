#!/usr/bin/env node
'use strict';

/*
 * npm run doctor
 *
 * One command that answers: "if a customer tried to buy Pro right now, would it
 * work?" It reads .env (server/.env first, then ./.env), runs the same checks the
 * deployed /api/admin/payment-status endpoint runs, and prints what to fix.
 *
 * Exit code is 1 when payments are not ready, so it can gate a deploy.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function loadEnvFile() {
  const candidates = [path.join(ROOT, 'server', '.env'), path.join(ROOT, '.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    let applied = 0;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // A real environment variable always wins over the file.
      if (process.env[key] === undefined) {
        process.env[key] = value;
        applied += 1;
      }
    }
    return { file: path.relative(ROOT, file), applied };
  }
  return null;
}

const C = process.stdout.isTTY
  ? { pass: '\x1b[32m', fail: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { pass: '', fail: '', warn: '', dim: '', bold: '', off: '' };

function line(ok, name, detail, advisory) {
  const tag = ok ? `${C.pass}PASS${C.off}` : advisory ? `${C.warn}WARN${C.off}` : `${C.fail}FAIL${C.off}`;
  console.log(`  ${tag}  ${name.padEnd(15)} ${C.dim}${detail}${C.off}`);
}

async function main() {
  const env = loadEnvFile();

  console.log(`\n${C.bold}Trade Lock — payment readiness${C.off}\n`);
  if (env) {
    console.log(`  ${C.dim}Read ${env.applied} value(s) from ${env.file}${C.off}`);
  } else {
    console.log(`  ${C.warn}No .env found.${C.off} ${C.dim}Copy server/.env.example to server/.env and fill it in.${C.off}`);
  }
  console.log('');

  const status = require(path.join(ROOT, 'server', 'paymentStatus'));
  const report = await status.collect();

  for (const [name, check] of Object.entries(report.checks)) {
    line(check.ok, name, check.detail, check.advisory);
  }

  console.log('');
  if (report.demoCheckout) {
    console.log(`  ${C.warn}Demo checkout is ON.${C.off} ${C.dim}Licences would be issued without payment. Local testing only.${C.off}`);
  }

  if (report.ok) {
    console.log(`  ${C.pass}${C.bold}Payments are ready.${C.off} ${C.dim}${report.next}${C.off}\n`);
    if (!report.paymentPersistenceReady) {
      console.log(`  ${C.warn}Warning:${C.off} ${C.dim}licences cannot be stored on this host.${C.off}\n`);
    }
    return 0;
  }

  console.log(`  ${C.fail}${C.bold}Not ready to take payments.${C.off}`);
  console.log(`  ${C.dim}Blocking: ${report.blocking.filter((k) => !report.checks[k].ok).join(', ')}${C.off}`);
  console.log(`  ${C.dim}Walkthrough: SUPABASE_SETUP.md, RAZORPAY_SETUP.md${C.off}\n`);
  return 1;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('\n  doctor failed:', error.message, '\n');
  process.exit(1);
});
