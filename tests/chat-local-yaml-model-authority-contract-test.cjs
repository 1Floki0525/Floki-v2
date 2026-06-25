"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "vendor",
  "state",
  "reports",
  ".floki-tools",
]);
const BACKUP_FILE = /(?:\.bak(?:\.|$)|\.backup(?:\.|$)|~$|\.orig$|\.rej$)/i;
const MODEL_TAG = /\b(?:floki-)?qwen[\w.-]*:[\w.-]+\b/gi;

function walk(directory, callback) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, callback);
    else callback(full, entry.name);
  }
}

function run() {
  assert.equal(process.version, "v24.17.0", "Node v24.17.0 is required");

  const chatYaml = path.join(CONFIG_DIR, "chat.config.yaml");
  const yamlText = fs.readFileSync(chatYaml, "utf8");
  assert.match(yamlText, /^\s*model:\s*\S+/m, "chat.config.yaml must declare models with model:");
  assert.doesNotMatch(yamlText, /^\s*model_env:/m);
  assert.doesNotMatch(yamlText, /^\s*model_default:/m);
  assert.doesNotMatch(yamlText, /^\s*vision_model_env:/m);
  assert.doesNotMatch(yamlText, /^\s*vlm_ssh_tunnel_required_model:/m);

  const cfg = require("../src/config/floki-config.cjs");
  cfg.clearConfigCache();
  const original = cfg.loadFlokiConfig("chat");
  const cognitionModel = original.models.cognition.model;
  const visionModel = original.models.vision.model;

  const oldCognition = process.env.FLOKI_COGNITION_MODEL;
  const oldVision = process.env.FLOKI_VISION_MODEL;
  process.env.FLOKI_COGNITION_MODEL = "environment-must-not-select-a-model";
  process.env.FLOKI_VISION_MODEL = "environment-must-not-select-a-model";
  cfg.clearConfigCache();
  const overridden = cfg.loadFlokiConfig("chat");
  assert.equal(overridden.models.cognition.model, cognitionModel);
  assert.equal(overridden.models.vision.model, visionModel);
  if (oldCognition === undefined) delete process.env.FLOKI_COGNITION_MODEL;
  else process.env.FLOKI_COGNITION_MODEL = oldCognition;
  if (oldVision === undefined) delete process.env.FLOKI_VISION_MODEL;
  else process.env.FLOKI_VISION_MODEL = oldVision;
  cfg.clearConfigCache();

  for (const relative of [
    "src/config/floki-config.cjs",
    "src/brain/floki-brain.cjs",
  ]) {
    const text = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.doesNotMatch(text, /resolveEnvOrDefault\(section,\s*["']model_env["']/);
    assert.doesNotMatch(text, /section\.model_default/);
  }

  const hardcoded = [];
  walk(ROOT, (file) => {
    if (file.startsWith(CONFIG_DIR + path.sep)) return;
    if (!/\.(?:cjs|mjs|js|jsx|ts|tsx|md|json|html|css|sh)$/i.test(file)) return;
    const text = fs.readFileSync(file, "utf8");
    const matches = text.match(MODEL_TAG) || [];
    if (matches.length) {
      hardcoded.push(path.relative(ROOT, file) + ": " + Array.from(new Set(matches)).join(", "));
    }
  });
  assert.deepEqual(hardcoded, [], "model tags must exist only in config/*.yaml:\n" + hardcoded.join("\n"));

  const backupFiles = [];
  function walkBackups(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/^backups?$/i.test(entry.name)) backupFiles.push(path.relative(ROOT, full) + "/");
        else walkBackups(full);
      } else if (BACKUP_FILE.test(entry.name)) {
        backupFiles.push(path.relative(ROOT, full));
      }
    }
  }
  walkBackups(ROOT);
  assert.deepEqual(backupFiles, [], "backup debris remains:\n" + backupFiles.join("\n"));

  console.log(JSON.stringify({
    ok: true,
    marker: "FLOKI_CHAT_LOCAL_YAML_MODEL_AUTHORITY_PASS",
    cognition_model_source: "config/chat.config.yaml",
    vision_model_source: "config/chat.config.yaml",
    environment_model_override_blocked: true,
    model_tags_outside_yaml: 0,
    backup_files_remaining: 0,
    other_modes_loaded: false,
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    marker: "FLOKI_CHAT_LOCAL_YAML_MODEL_AUTHORITY_FAIL",
    error: error.message,
    other_modes_loaded: false,
  }, null, 2));
  process.exit(1);
}
