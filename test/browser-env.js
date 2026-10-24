'use strict';

const fs = require('node:fs');

function loadPuppeteer() {
  for (const name of ['puppeteer-core', 'puppeteer']) {
    try { return require(name); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Browser tests require dev dependencies. Run `npm ci` first.');
}

function chromeExecutable(puppeteer) {
  const explicit = process.env.CHROME_PATH || process.env.CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error('Configured Chrome executable does not exist: ' + explicit);
    return explicit;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome',
  ];
  const installed = candidates.find(file => fs.existsSync(file));
  if (installed) return installed;
  throw new Error('No Chrome executable found. Set CHROME_PATH (or install Chrome and use PUPPETEER_EXECUTABLE_PATH).');
}

module.exports = { loadPuppeteer, chromeExecutable };
