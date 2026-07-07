"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const sourceScript = String(packageJson.scripts && packageJson.scripts["test:node24"] || "");

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error("FLOKI_CHAT_LOCAL_SUITE_FAIL: Node 24 or newer is required; actual=" + process.version);
  process.exit(1);
}
if (!sourceScript.trim()) {
  console.error("FLOKI_CHAT_LOCAL_SUITE_FAIL: package.json scripts.test:node24 is missing");
  process.exit(1);
}

const explicitCrossMode = new Set([
  "tests/config-public-api-contract-test.cjs",
  "tests/config-authority-contract-test.cjs",
  "tests/strict-mode-config-isolation-contract-test.cjs",
  "tests/no-hardcoded-runtime-config-contract-test.cjs",
  "tests/yaml-driven-paths-contract-test.cjs",
  "tests/vision-source-router-contract-test.cjs",
  "tests/vision-status-contract-test.cjs",
  "tests/core-brain-config-contract-test.cjs",
  "tests/core-brain-mode-isolation-contract-test.cjs",
  "tests/core-brain-status-contract-test.cjs",
  "tests/chat-embodiment-config-contract-test.cjs",
  "tests/game-vision-source-contract-test.cjs",
  "tests/game-core-brain-entrypoint-contract-test.cjs",
  "tests/identity-runtime-truth-contract-test.cjs",
  "tests/live-chat-dual-input-contract-test.cjs",
  "tests/personality-identity-contract-test.cjs",
  "tests/spoken-vision-context-injection-contract-test.cjs",
  "tests/yaml-model-authority-contract-test.cjs",
  "tests/yaml-model-consumer-contract-test.cjs",
  "tests/ci-public-template-paths-contract-test.cjs",
  "tests/youtube-build-release-contract-test.cjs",
  "tests/eastern-time-sleep-contract-test.cjs",
]);

const directOtherModeAccess = [
  /game\.config\.yaml/,
  /loadFlokiConfig\(\s*["']game["']/,
  /getFlokiConfig\(\s*["']game["']/,
  /getPathConfig\(\s*["']game["']/,
  /getModelConfig\(\s*["']game["']/,
  /getVisionConfig\(\s*["']game["']/,
  /getGameWorldVisionConfig\s*\(/,
  /loadCoreBrainConfig\(\s*["']game["']/,
  /buildCoreBrainStatus\(\s*["']game["']/,
  /resolveVisionSource\(\s*\{[\s\S]{0,200}?mode\s*:\s*["']game["']/,
  /\[\s*["']chat["']\s*,\s*["']game["']\s*\]/,
];

const mandatory = [
  "tests/chat-local-config-authority-contract-test.cjs",
  "tests/chat-local-yaml-model-authority-contract-test.cjs",
  "tests/host-config-protection-contract-test.cjs",
  "tests/yaml-driven-audio-sleep-dream-contract-test.cjs",
  "tests/chat-local-single-runtime-contract-test.cjs",
  "tests/chat-local-live-voice-contract-test.cjs",
  "tests/chat-local-interface-lifecycle-transcript-contract-test.cjs",
  "tests/live-audio-production-contract-test.cjs",
  "tests/live-audio-behavioral-contract-test.cjs",
  "tests/wake-word-gate-contract-test.cjs",
  "tests/wake-command-continuation-contract-test.cjs",
  "tests/voice-output-lock-contract-test.cjs",
  "tests/speaker-playback-voice-lock-contract-test.cjs",
  "tests/self-echo-regression-contract-test.cjs",
  "tests/dream-quality-regeneration-contract-test.cjs",
  "tests/manual-nap-rem-retry-contract-test.cjs",
  "tests/sleep-scheduler-dream-rejection-survival-contract-test.cjs",
];

function normalizedTestPath(command) {
  const match = command.trim().match(/^node\s+([^\s]+\.cjs)$/);
  return match ? match[1].replace(/\\/g, "/") : null;
}

function skipReason(relative) {
  if (explicitCrossMode.has(relative)) return "cross-mode contract";
  if (path.basename(relative).startsWith("game-")) return "other-mode contract";
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  const source = fs.readFileSync(absolute, "utf8");
  if (directOtherModeAccess.some((pattern) => pattern.test(source))) return "direct other-mode access";
  return null;
}

const selected = [];
const skipped = [];
const seen = new Set();

function add(relative, source) {
  const normalized = relative.replace(/\\/g, "/");
  if (seen.has(normalized)) return;
  const absolute = path.join(ROOT, normalized);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    console.error("FLOKI_CHAT_LOCAL_SUITE_FAIL: missing " + source + " test: " + normalized);
    process.exit(1);
  }
  const reason = skipReason(normalized);
  if (reason) {
    if (source === "mandatory") {
      console.error("FLOKI_CHAT_LOCAL_SUITE_FAIL: mandatory test was classified outside chat.local scope: " + normalized + " reason=" + reason);
      process.exit(1);
    }
    skipped.push({ test: normalized, reason });
    seen.add(normalized);
    return;
  }
  selected.push(normalized);
  seen.add(normalized);
}

for (const relative of mandatory) add(relative, "mandatory");

for (const command of sourceScript.split(/\s*&&\s*/)) {
  const relative = normalizedTestPath(command);
  if (!relative) {
    console.error("FLOKI_CHAT_LOCAL_SUITE_FAIL: unsupported test command in test:node24: " + command);
    process.exit(1);
  }
  add(relative, "repository");
}

if (selected.length < mandatory.length) {
  console.error("FLOKI_CHAT_LOCAL_SUITE_FAIL: selected suite is unexpectedly small");
  process.exit(1);
}

for (let index = 0; index < selected.length; index += 1) {
  const relative = selected[index];
  console.log("\n=== CHAT.LOCAL TEST " + String(index + 1) + "/" + String(selected.length) + ": " + relative + " ===");
  const result = spawnSync(process.execPath, [path.join(ROOT, relative)], {
    cwd: ROOT,
    env: {
      ...process.env,
      FLOKI_ACTIVE_TEST_PROFILE: "chat.local",
    },
    stdio: "inherit",
  });
  if (result.error) {
    console.error("FLOKI_CHAT_LOCAL_SUITE_FAIL: " + relative + ": " + result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error("FLOKI_CHAT_LOCAL_SUITE_FAIL: " + relative + " status=" + String(result.status));
    process.exit(result.status || 1);
  }
}

console.log(JSON.stringify({
  ok: true,
  marker: "FLOKI_CHAT_LOCAL_SUITE_PASS",
  tests_run: selected.length,
  tests_skipped_outside_scope: skipped.length,
  skipped,
  other_modes_loaded_by_suite: false,
}, null, 2));
