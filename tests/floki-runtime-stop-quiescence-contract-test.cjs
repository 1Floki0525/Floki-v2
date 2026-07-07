"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const runtimeScript = path.join(root, "bin", "floki-runtime.sh");
const source = fs.readFileSync(runtimeScript, "utf8");

for (const required of [
  "project_process_control()",
  "verify_shutdown_quiescence()",
  "FLOKI_RUNTIME_SHUTDOWN_QUIESCENCE_PASS",
  "FLOKI_RUNTIME_SHUTDOWN_QUIESCENCE_FAIL",
  "chat-local-runtime.cjs",
  "sleep-cycle-scheduler.cjs",
  "chat-webcam-vision-service.cjs",
  "yolo-worker.py",
  "grounding-dino-worker.py",
  "floki-neural-interface",
  "chat-vision-local.sock",
  "mainthread",
  "/dev/video",
  "os.killpg",
  "signal.SIGTERM",
  "signal.SIGKILL",
]) {
  assert.ok(source.toLowerCase().includes(required.toLowerCase()), `missing shutdown contract marker: ${required}`);
}

const stopCase = source.slice(source.indexOf("  stop)"), source.indexOf("  restart)"));
for (const required of ["stop_app", "stop_project_processes", "verify_shutdown_quiescence"]) {
  assert.ok(stopCase.includes(required), `stop action missing ${required}`);
}
const verifyIndex = stopCase.indexOf("verify_shutdown_quiescence");
const readyIndex = stopCase.indexOf("if runtime_ready");
const passIndex = stopCase.indexOf("FLOKI_RUNTIME_STOP_PASS");
assert.ok(verifyIndex >= 0 && verifyIndex < readyIndex);
assert.ok(readyIndex >= 0 && readyIndex < passIndex);

const syntax = spawnSync("bash", ["-n", runtimeScript], { cwd: root, encoding: "utf8" });
assert.equal(syntax.status, 0, `bash syntax check failed:\n${syntax.stdout}\n${syntax.stderr}`);

const dryRun = spawnSync("bash", [runtimeScript, "stop"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, FLOKI_COMMANDS_DRY_RUN: "1" },
  timeout: 30000,
});
assert.equal(dryRun.status, 0, `stop dry-run failed:\n${dryRun.stdout}\n${dryRun.stderr}`);
assert.match(dryRun.stdout, /FLOKI_RUNTIME_STOP_DRY_RUN/);

console.log("FLOKI_RUNTIME_STOP_QUIESCENCE_CONTRACT_PASS");
