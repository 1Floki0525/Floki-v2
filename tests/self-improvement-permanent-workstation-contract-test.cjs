"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const template = fs.readFileSync(
  path.join(ROOT, "config/chat.config.yaml.temp"),
  "utf8"
);
const containerfile = fs.readFileSync(
  path.join(ROOT, "containers/self-improvement/Containerfile"),
  "utf8"
);
const sandbox = fs.readFileSync(
  path.join(ROOT, "src/self-improvement/sandbox.cjs"),
  "utf8"
);

for (const token of [
  "persistent_container_name: floki-rsi-workstation",
  "container_hostname: sandbox",
  "persistent_project_workspace_path: /home/floki/Floki-v2",
  "workspace_mount_path: /home/floki/Floki-v2",
  "agent_home_path: /home/floki",
  "workspace_mount_options: ro,Z",
  "ubuntu-server",
  "systemd",
  "socat"
]) {
  assert.ok(template.includes(token), "missing permanent-workstation YAML token: " + token);
}

for (const token of [
  "FLOKI_RSI_FULL_UBUNTU_WORKSTATION_V1",
  "STOPSIGNAL SIGRTMIN+3",
  "floki:x:0:0:Floki:/home/floki:/bin/bash",
  'ENTRYPOINT ["/sbin/init"]'
]) {
  assert.ok(containerfile.includes(token), "missing full Ubuntu workstation image token: " + token);
}

for (const token of [
  "'--systemd=always'",
  "'--cgroupns=private'",
  "'--stop-signal', 'SIGRTMIN+3'",
  "persistent_sandbox_image_drift_preserved",
  "persistent_workstation_project_initialized",
  "persistent_workstation_project_preserved",
  "preserved_existing_workspace"
]) {
  assert.ok(sandbox.includes(token), "missing permanent sandbox lifecycle token: " + token);
}

const syncStart = sandbox.indexOf("function syncPersistentProjectWorkspace");
const syncEnd = sandbox.indexOf("function inspectPersistentContainer", syncStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart);
const syncBody = sandbox.slice(syncStart, syncEnd);
assert.doesNotMatch(
  syncBody,
  /--delete/,
  "persistent project workspace must never be rsync --deleted on later RSI runs"
);
assert.doesNotMatch(
  sandbox,
  /persistent RSI sandbox image changed while a run is active; reprovision when idle/,
  "bootstrap image drift must not force destructive workstation reprovisioning"
);

console.log(JSON.stringify({
  ok: true,
  marker: "FLOKI_RSI_PERMANENT_UBUNTU_WORKSTATION_CONTRACT_PASS",
  persistent_container: true,
  full_ubuntu_userspace: true,
  real_uid0_floki_identity: true,
  destructive_workspace_resync_removed: true,
  image_drift_preserves_workstation: true
}, null, 2));
