#!/usr/bin/env node
'use strict';

/*
 * scripts/check-undefined-calls.js
 *
 * This codebase has no bundler and no type checker; every file is loaded as a
 * classic script into a shared global scope. That makes one bug easy to ship and
 * hard to see in review: calling a helper that does not exist. It throws only on
 * the path that uses it, which is usually the rare path - an order being blocked,
 * an empty state, an error branch. That is exactly how `showToast` shipped
 * undefined in content/lock.js: the order was blocked, then the notification
 * threw, and the user was told nothing.
 *
 * This walks the real AST (acorn) and reports call expressions whose callee is a
 * bare identifier that is never declared in the file and is not a known built-in.
 *
 * Run: node scripts/check-undefined-calls.js
 */

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');

const FILES = [
  'background.js',
  'content/lock.js',
  'popup/popup.js',
  'options/options.js',
  'lib/rules.js',
  'lib/detector.js',
  'lib/insights.js',
  'lib/license.js',
  'server/index.js',
  'server/license.js',
  'server/ai.js',
  'server/email.js',
  'server/marketFeed.js',
  'server/supabase.js',
  'server/paymentStatus.js',
];

/**
 * Names available without a local declaration. This is the JS language plus the
 * browser and extension hosts. Anything else must be declared in the file.
 */
const BUILTINS = new Set([
  'Object', 'Function', 'Boolean', 'Symbol', 'Error', 'AggregateError', 'EvalError',
  'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
  'Number', 'BigInt', 'Math', 'Date', 'String', 'RegExp', 'Array', 'Int8Array',
  'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'ArrayBuffer',
  'SharedArrayBuffer', 'DataView', 'JSON', 'Promise', 'Reflect', 'Proxy',
  'Intl', 'WeakRef', 'FinalizationRegistry', 'Atomics',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'eval',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'structuredClone', 'reportError', 'fetch', 'atob', 'btoa', 'require',
  'globalThis', 'console',
  'window', 'self', 'document', 'navigator', 'location', 'history', 'screen',
  'localStorage', 'sessionStorage', 'alert', 'confirm', 'prompt',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'postMessage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'cancelIdleCallback', 'getComputedStyle', 'matchMedia', 'scrollTo', 'scrollBy',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver',
  'CustomEvent', 'Event', 'EventTarget', 'AbortController', 'AbortSignal',
  'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData', 'Headers',
  'Request', 'Response', 'TextEncoder', 'TextDecoder', 'DOMParser',
  'XMLHttpRequest', 'WebSocket', 'OffscreenCanvas', 'Image', 'Audio',
  'Notification', 'PerformanceObserver', 'indexedDB', 'crypto',
  'chrome', 'browser', 'importScripts',
]);

/** Node's CommonJS module wrapper parameters. */
const MODULE_SCOPE = ['module', 'exports', '__dirname', '__filename'];

function parse(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowHashBang: true,
    // Content scripts and the service worker are classic scripts; they use
    // `return` only inside functions, so a syntax error here is a real bug.
    locations: true,
  });
}

/** Generic AST walk that visits every node. */
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit);
    }
  }
}

/**
 * Every name the file introduces: declarations, parameters, catch bindings,
 * imports, and the CommonJS wrapper's own parameters.
 */
function declaredNames(ast) {
  const names = new Set();
  const addPattern = (pattern) => {
    if (!pattern) return;
    switch (pattern.type) {
      case 'Identifier': names.add(pattern.name); break;
      case 'ObjectPattern':
        for (const p of pattern.properties) {
          addPattern(p.type === 'RestElement' ? p.argument : p.value);
        }
        break;
      case 'ArrayPattern':
        for (const el of pattern.elements) addPattern(el);
        break;
      case 'AssignmentPattern': addPattern(pattern.left); break;
      case 'RestElement': addPattern(pattern.argument); break;
      default: break;
    }
  };

  walk(ast, (node) => {
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        for (const p of node.params) addPattern(p);
        if (node.id && node.id.type === 'Identifier') names.add(node.id.name);
        break;
      case 'VariableDeclarator': addPattern(node.id); break;
      case 'CatchClause': addPattern(node.param); break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) names.add(node.id.name);
        break;
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
      case 'ImportSpecifier':
        if (node.local) names.add(node.local.name);
        break;
      default: break;
    }
  });

  for (const name of MODULE_SCOPE) names.add(name);
  return names;
}

function scan(file) {
  const ast = parse(file);
  const declared = declaredNames(ast);
  // The UMD `lib/` files export through `module.exports`, others assign globals.
  const findings = [];

  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (!callee || callee.type !== 'Identifier') return;
    const name = callee.name;
    if (declared.has(name) || BUILTINS.has(name)) return;
    findings.push({
      file,
      line: node.loc ? node.loc.start.line : 0,
      name,
    });
  });

  // A name declared later in the file still counts (function hoisting), which is
  // why `declared` is built from the whole AST before checking any call.
  return findings;
}

function main() {
  const findings = [];
  for (const file of FILES) {
    try {
      findings.push(...scan(file));
    } catch (error) {
      console.error('[undefined-calls] could not parse ' + file + ': ' + error.message);
      return 1;
    }
  }

  if (!findings.length) {
    console.log('[undefined-calls] OK (' + FILES.length + ' files)');
    return 0;
  }

  console.error('[undefined-calls] ' + findings.length + ' call(s) to helpers that do not exist:');
  for (const f of findings) {
    console.error('  ' + f.file + ':' + f.line + '  ' + f.name + '()');
  }
  console.error('\nThese throw only on the path that reaches them.');
  return 1;
}

module.exports = { scan, declaredNames, FILES, BUILTINS };

if (require.main === module) {
  process.exit(main());
}
