'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

const yaml = read('config/chat.config.yaml');
const yamlTemplate = read('config/chat.config.yaml.temp');
const config = read('src/config/floki-config.cjs');
const agent = read('containers/self-improvement/agent.cjs');
const sandbox = read('src/self-improvement/sandbox.cjs');
const registry = read('src/control-plane/module-registry.cjs');
const workspace = read('src/control-plane/log-workspace.cjs');
const api = read('src/runtime/chat-local-interface-api.cjs');
const adapter = read(
  'apps/floki-neural-interface/src/integrations/floki/adapter.js'
);
const electron = read(
  'apps/floki-neural-interface/electron/main.cjs'
);
const backend = read(
  'apps/Floki-mobile-app/app/src/main/java/com/floki/neural/data/FlokiBackend.kt'
);
const vm = read(
  'apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiViewModel.kt'
);
const ui = read(
  'apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiAppRoot.kt'
);

for (const source of [yaml, yamlTemplate]) {
  assert.match(
    source,
    /dependency_install_timeout_ms:\s*120000/
  );
}

assert.match(
  config,
  /dependency_install_timeout_ms:\s*numberValue\('dependency_install_timeout_ms'\)/
);
assert.match(
  sandbox,
  /dependency_install_timeout_ms:\s*config\.dependency_install_timeout_ms/
);
assert.match(
  sandbox,
  /function seedPersistentDependencyCaches/
);
assert.match(
  sandbox,
  /seedPersistentDependencyCaches\(config\)/
);
assert.match(
  sandbox,
  /seedPersistentDependencyCaches,/
);

assert.match(
  agent,
  /const DEPENDENCY_INSTALL_TIMEOUT_MS =\s*requireNumber\('dependency_install_timeout_ms'\)/
);
assert.match(
  agent,
  /identity === 'interface_install'/
);
assert.match(
  agent,
  /identity === 'root_install'/
);
assert.match(
  agent,
  /DEPENDENCY_INSTALL_TIMEOUT_MS/
);

assert.match(
  registry,
  /web_app:\s*'web_app'/
);
assert.match(
  registry,
  /mobile_app:\s*'mobile_app'/
);
assert.match(
  registry,
  /log_available:\s*true/
);

assert.match(
  workspace,
  /currentWeekStamp/
);
assert.match(
  workspace,
  /ensureCurrentWeekWorkspace/
);
assert.match(
  workspace,
  /rsi_worker/
);
assert.match(
  workspace,
  /rsi_sandbox/
);
assert.match(
  workspace,
  /redactLogText/
);
assert.match(
  workspace,
  /synchronizeCurrentWeekLog/
);

assert.match(
  api,
  /readLogWorkspace/
);
assert.match(
  api,
  /ensureCurrentWeekWorkspace\(\)/
);
assert.match(
  api,
  /return readLogWorkspace\(service\)/
);

assert.match(
  adapter,
  /function createInAppLogWorkspace/
);
assert.match(
  adapter,
  /Search this week/
);
assert.match(
  adapter,
  /live refresh every 5s/
);
assert.match(
  adapter,
  /async openLog\(service\)/
);

assert.doesNotMatch(
  electron,
  /shell\.openPath/
);
assert.doesNotMatch(
  electron,
  /shell\.showItemInFolder/
);
assert.match(
  electron,
  /text:\s*String\(result\.text \|\| ''\)/
);

assert.match(
  backend,
  /suspend fun getLog\(service: String\)/
);
assert.match(
  vm,
  /val logWorkspaceTitle: String\? = null/
);
assert.match(
  vm,
  /fun openLog\(service: String\)/
);
assert.match(
  vm,
  /fun closeLogWorkspace\(\)/
);
assert.match(
  vm,
  /requireCapability\(\s*"logs:read"/
);
assert.match(
  ui,
  /LogWorkspaceDialog\(state, vm\)/
);
assert.match(
  ui,
  /vm\.openLog\(service\.logKey \?: service\.key\)/
);
assert.match(
  ui,
  /vm\.openLog\("rsi_worker"\)/
);
assert.match(
  ui,
  /vm\.openLog\("rsi_sandbox"\)/
);

console.log(
  'FLOKI_RSI_INSTALL_STALL_WEEKLY_LOG_WORKSPACE_CONTRACT_PASS'
);
