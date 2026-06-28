'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const trainFile = path.join(
  ROOT,
  'containers/self-improvement-training/train_qlora.py'
);
const remFile = path.join(
  ROOT,
  'containers/self-improvement-training/rem_inference.py'
);
const containerFile = path.join(
  ROOT,
  'containers/self-improvement-training/Containerfile'
);

const train = fs.readFileSync(trainFile, 'utf8');
const rem = fs.readFileSync(remFile, 'utf8');
const containerfile = fs.readFileSync(containerFile, 'utf8');

for (const file of [trainFile, remFile]) {
  const result = spawnSync(
    'python3',
    ['-m', 'py_compile', file],
    {
      cwd: ROOT,
      encoding: 'utf8'
    }
  );
  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout
  );
}

const {
  loadSelfImprovementConfig
} = require('../src/self-improvement/config.cjs');
const {
  buildTrainingConfig
} = require(
  '../src/self-improvement/training/qlora-config.cjs'
);

const config = loadSelfImprovementConfig();
const generated = buildTrainingConfig({ config });

const filenameTransport = Object.freeze([
  Object.freeze({
    payloadKey: 'trainer_state_file_name',
    yamlKey: 'training_trainer_state_file_name'
  }),
  Object.freeze({
    payloadKey: 'optimizer_state_file_name',
    yamlKey: 'training_optimizer_state_file_name'
  }),
  Object.freeze({
    payloadKey: 'lr_scheduler_state_file_name',
    yamlKey: 'training_lr_scheduler_state_file_name'
  }),
  Object.freeze({
    payloadKey: 'rng_state_file_name',
    yamlKey: 'training_rng_state_file_name'
  }),
  Object.freeze({
    payloadKey: 'metrics_file_name',
    yamlKey: 'training_metrics_file_name'
  })
]);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const { payloadKey, yamlKey } of filenameTransport) {
  const configured = config[yamlKey];
  assert.equal(
    typeof configured,
    'string',
    yamlKey + ' must be supplied by chat YAML'
  );
  assert.ok(
    configured.trim().length > 0,
    yamlKey + ' must not be empty'
  );
  assert.equal(
    generated[payloadKey],
    configured,
    payloadKey + ' must be transported from ' + yamlKey
  );

  assert.match(
    train,
    new RegExp(
      'config\\[["\\\']' +
      escapeRegex(payloadKey) +
      '["\\\']\\]'
    ),
    'trainer must consume generated config key ' + payloadKey
  );

  assert.doesNotMatch(
    train,
    new RegExp(
      '["\\\']' +
      escapeRegex(configured) +
      '["\\\']'
    ),
    'trainer must not hardcode YAML filename ' + configured
  );
}

assert.equal(
  generated.checkpoint_dir_prefix,
  config.training_checkpoint_dir_prefix
);
assert.match(train, /checkpoint_and_stop/);
assert.match(train, /resume_from_checkpoint/);
assert.match(train, /optimizer_state_file_name/);
assert.match(train, /lr_scheduler_state_file_name/);
assert.match(train, /rng_state_file_name/);
assert.match(
  train,
  /FLOKI_V2_RSI_TRAINING_CHECKPOINT_ACK/
);

const helperProbe = String.raw`
import importlib.util
import json
import pathlib
import sys
import tempfile

module_path = pathlib.Path(sys.argv[1])
checkpoint_prefix = sys.argv[2]
trainer_state_name = sys.argv[3]
metrics_name = sys.argv[4]

spec = importlib.util.spec_from_file_location(
    "floki_train_qlora_contract",
    module_path,
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(
    prefix="floki-checkpoint-contract-"
) as temp:
    root = pathlib.Path(temp)
    older = root / (checkpoint_prefix + "2")
    newer = root / (checkpoint_prefix + "9")
    incomplete = root / (checkpoint_prefix + "12")
    older.mkdir()
    newer.mkdir()
    incomplete.mkdir()
    (older / trainer_state_name).write_text(
        "{}\n",
        encoding="utf-8",
    )
    (newer / trainer_state_name).write_text(
        "{}\n",
        encoding="utf-8",
    )

    selected = module.latest_checkpoint(
        str(root),
        checkpoint_prefix,
        trainer_state_name,
    )
    if selected != str(newer):
        raise SystemExit(
            "latest_checkpoint selected unexpected path: " +
            str(selected)
        )

    module.write_metrics(
        str(root),
        {"ok": True, "source": "yaml-authority-contract"},
        metrics_name,
    )
    metrics_path = root / metrics_name
    if not metrics_path.is_file():
        raise SystemExit(
            "configured metrics file was not written"
        )
    payload = json.loads(
        metrics_path.read_text(encoding="utf-8")
    )
    if payload.get("ok") is not True:
        raise SystemExit(
            "configured metrics payload is invalid"
        )

print("FLOKI_RSI_TRAINING_CHECKPOINT_HELPERS_PASS")
`;

const helperResult = spawnSync(
  'python3',
  [
    '-c',
    helperProbe,
    trainFile,
    generated.checkpoint_dir_prefix,
    generated.trainer_state_file_name,
    generated.metrics_file_name
  ],
  {
    cwd: ROOT,
    encoding: 'utf8'
  }
);
assert.equal(
  helperResult.status,
  0,
  helperResult.stderr || helperResult.stdout
);
assert.match(
  helperResult.stdout,
  /FLOKI_RSI_TRAINING_CHECKPOINT_HELPERS_PASS/
);

assert.match(rem, /BitsAndBytesConfig/);
assert.match(rem, /PeftModel\.from_pretrained/);
assert.match(rem, /FLOKI_V2_HF_REM_INFERENCE_PASS/);
assert.match(
  containerfile,
  /ARG REM_INFERENCE_SCRIPT_PATH/
);
assert.match(
  containerfile,
  /COPY rem_inference\.py \$\{REM_INFERENCE_SCRIPT_PATH\}/
);
assert.doesNotMatch(
  containerfile,
  /COPY rem_inference\.py \/opt\/floki-training\/rem_inference\.py/,
  'REM inference destination must remain YAML-driven'
);

console.log(JSON.stringify({
  ok: true,
  marker:
    'FLOKI_RSI_NIGHTLY_TRAINING_CHECKPOINT_SOURCE_PASS',
  resumable_qlora: true,
  checkpoint_filenames_from_chat_yaml: true,
  hardcoded_checkpoint_filenames_rejected: true,
  checkpoint_discovery_executed: true,
  metrics_write_executed: true,
  optimizer_scheduler_rng_state_saved: true,
  rem_inference_destination_from_chat_yaml: true,
  one_shot_hf_rem_inference: true
}, null, 2));
