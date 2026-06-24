'use strict';

const { loadSelfImprovementConfig } = require('./config.cjs');

const key = String(process.argv[2] || '').trim();
if (!key) {
  throw new Error('self-improvement config key is required');
}
const config = loadSelfImprovementConfig();
if (!Object.prototype.hasOwnProperty.call(config, key)) {
  throw new Error('unknown self-improvement config key: ' + key);
}
const value = config[key];
if (value && typeof value === 'object') {
  process.stdout.write(JSON.stringify(value));
} else {
  process.stdout.write(String(value));
}
