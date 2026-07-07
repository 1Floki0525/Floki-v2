'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const trainer = path.join(root, 'containers/self-improvement-training/train_qlora.py');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-trainer-helper-'));
const helper = path.join(temp, 'verify.py');

fs.writeFileSync(helper, `
import json
import os
import runpy
import sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
root = Path(sys.argv[2])
module['write_metrics'](str(root), {'global_step': 7}, 'configured-metrics.json')
assert json.loads((root / 'configured-metrics.json').read_text())['global_step'] == 7
(root / 'configured-checkpoint-2').mkdir()
(root / 'configured-checkpoint-2' / 'configured-state.json').write_text('{}')
(root / 'configured-checkpoint-11').mkdir()
(root / 'configured-checkpoint-11' / 'configured-state.json').write_text('{}')
latest = module['latest_checkpoint'](str(root), 'configured-checkpoint-', 'configured-state.json')
assert latest.endswith('configured-checkpoint-11'), latest
print('FLOKI_RSI_TRAINING_PYTHON_HELPER_PASS')
`, 'utf8');

const result = spawnSync('python3', [helper, trainer, temp], {
  cwd: root,
  encoding: 'utf8'
});
try {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /FLOKI_RSI_TRAINING_PYTHON_HELPER_PASS/);
  const source = fs.readFileSync(trainer, 'utf8');
  const sessionSource = fs.readFileSync(path.join(root, 'src/self-improvement/training/nightly-training-session.cjs'), 'utf8');
  assert.match(sessionSource, /function readJson\(file, fallback = null\)/);
  assert.match(sessionSource, /FLOKI_NIGHTLY_TRAINING_CONTAINER_CLEANUP_FAILED/);
  for (const literal of ['trainer_state.json', 'optimizer.pt', 'scheduler.pt', 'rng_state.pth']) {
    assert.equal(source.includes(literal), false, 'training state filename must come from chat YAML: ' + literal);
  }
  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_RSI_TRAINING_PYTHON_HELPER_CONTRACT_PASS',
    metrics_filename_configured: true,
    checkpoint_prefix_configured: true,
    trainer_state_filename_configured: true
  }, null, 2));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
