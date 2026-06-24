'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function text(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

const operationalFiles = [
  'src/self-improvement/config.cjs',
  'src/self-improvement/config-cli.cjs',
  'src/self-improvement/store.cjs',
  'src/self-improvement/snapshot.cjs',
  'src/self-improvement/sandbox.cjs',
  'src/self-improvement/worker.cjs',
  'src/self-improvement/promotion.cjs',
  'src/self-improvement/promoter.cjs',
  'containers/self-improvement/Containerfile',
  'containers/self-improvement/agent.cjs',
  'bin/floki-self-improvement-start.sh',
  'bin/floki-self-improvement-stop.sh',
  'bin/floki-self-improvement-status.sh',
  'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'
];

const combined = operationalFiles
  .map((relative) => '\n/* ' + relative + ' */\n' + text(relative))
  .join('\n');

const forbiddenLiterals = [
  'http://127.0.0.1:',
  'https://html.duckduckgo.com',
  'https://api.github.com/search',
  'https://export.arxiv.org',
  'https://api.crossref.org',
  '@upstash/context7-mcp@',
  'node:24-bookworm',
  'localhost/floki-self-improvement:node24'
];

for (const literal of forbiddenLiterals) {
  assert.equal(
    combined.includes(literal),
    false,
    'operational RSI code hardcodes YAML setting: ' + literal
  );
}

const agent = text('containers/self-improvement/agent.cjs');
assert.doesNotMatch(
  agent,
  /process\.env\.FLOKI_RSI_[A-Z_]+\s*\|\|/,
  'agent must not have environment fallback defaults'
);
assert.doesNotMatch(
  agent,
  /(?:temperature|top_p|keep_alive)\s*:\s*(?:['"]?\d|['"]\d)/,
  'model generation settings must come from YAML'
);
assert.doesNotMatch(
  agent,
  /AbortSignal\.timeout\s*\(\s*\d+/,
  'agent timeout must come from YAML'
);
assert.doesNotMatch(
  agent,
  /maxBuffer\s*:\s*\d+/,
  'agent buffer limits must come from YAML'
);
assert.doesNotMatch(
  agent,
  /(?:webSearch|githubSearch|arxivSearch|crossrefSearch)\([^)]*=\s*\d+/,
  'research result defaults must come from YAML'
);

const hostModules = [
  'src/self-improvement/snapshot.cjs',
  'src/self-improvement/sandbox.cjs',
  'src/self-improvement/worker.cjs',
  'src/self-improvement/promoter.cjs'
].map(text).join('\n');

assert.doesNotMatch(
  hostModules,
  /timeout\s*:\s*\d{3,}/,
  'host RSI timeouts must come from YAML'
);
assert.doesNotMatch(
  hostModules,
  /maxBuffer\s*:\s*\d+/,
  'host RSI buffer limits must come from YAML'
);
assert.doesNotMatch(
  hostModules,
  /setInterval\s*\([^,]+,\s*\d+/,
  'host RSI poll intervals must come from YAML'
);

const containerfile = text('containers/self-improvement/Containerfile');
assert.doesNotMatch(
  containerfile,
  /^FROM\s+(?!\$\{BASE_IMAGE\})/m,
  'container base image must come from YAML build argument'
);
assert.doesNotMatch(
  containerfile,
  /npm install --global\s+@/,
  'Context7 package/version must come from YAML build arguments'
);

const startScript = text('bin/floki-self-improvement-start.sh');
const stopScript = text('bin/floki-self-improvement-stop.sh');
assert.match(startScript, /config_value service_start_attempts/);
assert.match(startScript, /config_value service_start_poll_seconds/);
assert.match(startScript, /config_value service_start_log_tail_lines/);
assert.match(stopScript, /config_value service_stop_attempts/);
assert.match(stopScript, /config_value service_stop_poll_seconds/);
assert.doesNotMatch(startScript, /seq 1 \d+|sleep 0\.\d+|tail -\d+/);
assert.doesNotMatch(stopScript, /seq 1 \d+|sleep 0\.\d+/);

const panel = text(
  'apps/floki-neural-interface/src/components/system/SelfImprovementPanel.jsx'
);
assert.match(panel, /nextStatus\?\.ui_poll_ms/);
assert.doesNotMatch(panel, /setInterval\s*\([^,]+,\s*\d+/);
assert.doesNotMatch(panel, /setTimeout\s*\([^,]+,\s*\d+/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_SELF_IMPROVEMENT_YAML_AUTHORITY_PASS'
}, null, 2));
