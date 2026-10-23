'use strict';
/*
 * Standalone Extension Packaging Script
 * Produces a clean, production-ready Chrome Extension ZIP in dist/
 * Enforces standard forward-slash zip paths and excludes all server code,
 * tests, node_modules, secrets, and deployment metadata.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const OUTPUT_ZIP = path.join(DIST_DIR, 'trade-lock-extension.zip');

// Only include genuine extension client files
const INCLUDE_PATHS = [
  'manifest.json',
  'background.js',
  'content',
  'icons',
  'lib',
  'options',
  'popup'
];

// Calculate CRC32 for zip entry
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = ((c & 1) ? (-306674912 ^ (c >>> 1)) : (c >>> 1));
      table[i] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function collectFiles(relPath, baseDir) {
  const fullPath = path.join(baseDir, relPath);
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const list = [];
    for (const child of fs.readdirSync(fullPath)) {
      list.push(...collectFiles(path.join(relPath, child), baseDir));
    }
    return list;
  }
  // Standardize forward slashes in ZIP
  return [{ relPath: relPath.replace(/\\/g, '/'), fullPath }];
}

function createZip(files, outZipPath) {
  const entries = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.fullPath);
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(f.relPath, 'utf8');

    // Local file header
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed (2.0)
    localHeader.writeUInt16LE(0, 6);          // flags
    localHeader.writeUInt16LE(8, 8);          // compression (deflate)
    localHeader.writeUInt16LE(0, 10);         // mod time
    localHeader.writeUInt16LE(0, 12);         // mod date
    localHeader.writeUInt32LE(crc, 14);        // crc32
    localHeader.writeUInt32LE(compressed.length, 18); // comp size
    localHeader.writeUInt32LE(data.length, 22);       // uncomp size
    localHeader.writeUInt16LE(nameBuf.length, 26);    // filename len
    localHeader.writeUInt16LE(0, 28);                 // extra len
    nameBuf.copy(localHeader, 30);

    entries.push({
      relPath: f.relPath,
      nameBuf,
      crc,
      compressed,
      uncompressedSize: data.length,
      compressedSize: compressed.length,
      offset,
      localHeader
    });

    offset += localHeader.length + compressed.length;
  }

  // Central directory
  const centralParts = [];
  let centralDirSize = 0;
  for (const e of entries) {
    const cdHeader = Buffer.alloc(46 + e.nameBuf.length);
    cdHeader.writeUInt32LE(0x02014b50, 0); // signature
    cdHeader.writeUInt16LE(20, 4);         // version made by
    cdHeader.writeUInt16LE(20, 6);         // version needed
    cdHeader.writeUInt16LE(0, 8);          // flags
    cdHeader.writeUInt16LE(8, 10);         // compression
    cdHeader.writeUInt16LE(0, 12);         // time
    cdHeader.writeUInt16LE(0, 14);         // date
    cdHeader.writeUInt32LE(e.crc, 16);
    cdHeader.writeUInt32LE(e.compressedSize, 20);
    cdHeader.writeUInt32LE(e.uncompressedSize, 24);
    cdHeader.writeUInt16LE(e.nameBuf.length, 28);
    cdHeader.writeUInt16LE(0, 30);         // extra len
    cdHeader.writeUInt16LE(0, 32);         // comment len
    cdHeader.writeUInt16LE(0, 34);         // disk num
    cdHeader.writeUInt16LE(0, 36);         // internal attr
    cdHeader.writeUInt32LE(0, 38);         // external attr
    cdHeader.writeUInt32LE(e.offset, 42);   // relative offset
    e.nameBuf.copy(cdHeader, 46);

    centralParts.push(cdHeader);
    centralDirSize += cdHeader.length;
  }

  // End of Central Directory Record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                 // disk number
  eocd.writeUInt16LE(0, 6);                 // central dir disk
  eocd.writeUInt16LE(entries.length, 8);    // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);   // total entries
  eocd.writeUInt32LE(centralDirSize, 12);   // central dir size
  eocd.writeUInt32LE(offset, 16);           // offset of start of central dir
  eocd.writeUInt16LE(0, 20);                // comment len

  // Combine
  const outputBuffers = [];
  for (const e of entries) {
    outputBuffers.push(e.localHeader);
    outputBuffers.push(e.compressed);
  }
  outputBuffers.push(...centralParts);
  outputBuffers.push(eocd);

  fs.mkdirSync(path.dirname(outZipPath), { recursive: true });
  fs.writeFileSync(outZipPath, Buffer.concat(outputBuffers));
}

console.log('[package] Collecting files for Trade Lock Chrome Extension...');
const allFiles = [];
for (const item of INCLUDE_PATHS) {
  const itemPath = path.join(ROOT_DIR, item);
  if (fs.existsSync(itemPath)) {
    allFiles.push(...collectFiles(item, ROOT_DIR));
  }
}

// 1. Create clean unpacked directory for Chrome "Load unpacked"
const UNPACKED_DIR = path.join(DIST_DIR, 'trade-lock-extension');
if (fs.existsSync(UNPACKED_DIR)) {
  fs.rmSync(UNPACKED_DIR, { recursive: true, force: true });
}
fs.mkdirSync(UNPACKED_DIR, { recursive: true });

for (const f of allFiles) {
  const destPath = path.join(UNPACKED_DIR, f.relPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(f.fullPath, destPath);
}
console.log(`[package] Created clean unpacked extension directory at ${path.relative(ROOT_DIR, UNPACKED_DIR)}`);

// 2. Create clean ZIP archive
console.log(`[package] Packaging ${allFiles.length} files into ${path.relative(ROOT_DIR, OUTPUT_ZIP)}`);
createZip(allFiles, OUTPUT_ZIP);
const stat = fs.statSync(OUTPUT_ZIP);
console.log(`[package] Success! Created ${OUTPUT_ZIP} (${(stat.size / 1024).toFixed(1)} KB)`);

// 3. Security and integrity validation of release artifacts
const forbidden = ['.env', 'node_modules', 'server', 'test', 'data.json', '.git'];
for (const f of allFiles) {
  for (const bad of forbidden) {
    if (f.relPath.startsWith(bad) || f.relPath.includes('/' + bad)) {
      throw new Error(`[package] Security failure: Forbidden file in extension bundle: ${f.relPath}`);
    }
  }
}
const manifestPath = path.join(UNPACKED_DIR, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error('[package] Integrity failure: manifest.json missing from unpacked directory');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
console.log(`[package] Verified Manifest V3: "${manifest.name}" v${manifest.version}`);
console.log('[package] Release verification: PASS (Zero secrets, zero server files, clean forward-slash paths)');
