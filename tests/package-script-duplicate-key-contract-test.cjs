'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pkgPath = path.resolve(__dirname, '..', 'package.json');
const raw = fs.readFileSync(pkgPath, 'utf8');

// Parse as raw text — JSON.parse swallows duplicates silently
// Find the scripts section key by key from raw lines
const lines = raw.split('\n');
let inScripts = false;
const keyCounts = {};

for (const line of lines) {
  const trimmed = line.trim();
  if (trimmed.startsWith('"scripts"')) {
    inScripts = true;
    continue;
  }
  if (inScripts && trimmed.startsWith('}')) {
    break;
  }
  if (inScripts) {
    const km = trimmed.match(/^"([^"]+)"\s*:/);
    if (km) {
      const key = km[1];
      keyCounts[key] = (keyCounts[key] || 0) + 1;
    }
  }
}

const duplicates = Object.entries(keyCounts).filter(([, count]) => count > 1);
if (duplicates.length > 0) {
  console.error('FAIL: Duplicate script keys found:');
  for (const [key, count] of duplicates) {
    console.error(`  "${key}" appears ${count} times`);
  }
  process.exit(1);
}

console.log(`PASS: package-script-duplicate-key — no duplicate keys in scripts (${Object.keys(keyCounts).length} unique keys)`);
