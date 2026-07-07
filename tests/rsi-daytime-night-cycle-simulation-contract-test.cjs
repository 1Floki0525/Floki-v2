'use strict';

// Daytime night-cycle simulation harness contract.
//
// Proves the safety properties of the day-test mechanism itself:
// - disabled by default: the CLI without a mode flag only prints usage and
//   importing the module never creates state;
// - every stateful config path is forced under the simulation root; pointing
//   any of them at production refuses to run;
// - the virtual clock never moves the host clock and only moves forward;
// - the production 23:00-07:00 YAML schedule is what the simulation windows
//   are computed from (schedule unchanged);
// - the CDI/GPU probe and the training-engine version preflight report
//   truthfully (podman 4.x blocked, 6.x allowed, fake engines skipped);
// - the UI status reader only surfaces snapshots explicitly marked as
//   simulation and never invents one.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SCOPED_PATH_KEYS,
  cdiGpuProbe,
  createNightCycleSimulation,
  createSimClock
} = require('../src/chat/night-cycle-simulation.cjs');
const {
  assertTrainingEngineReady,
  preflightTrainingEngine
} = require('../src/self-improvement/training/master-preflight.cjs');
const {
  readNightCycleSimulationStatus
} = require('../src/self-improvement/ui-status.cjs');
const {
  loadSelfImprovementConfig
} = require('../src/self-improvement/config.cjs');
const {
  getSleepWindowForDate
} = require('../src/chat/sleep-cycle.cjs');

function fakeSpawn(output, status = 0) {
  return () => ({ status, stdout: output, stderr: '', error: null });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-night-sim-contract-'));
  const production = loadSelfImprovementConfig();

  // --- Disabled by default ---
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'src', 'chat', 'night-cycle-simulation.cjs')
  ], { encoding: 'utf8', timeout: 60000 });
  assert.equal(cli.status, 0, cli.stderr);
  const ready = JSON.parse(cli.stdout);
  assert.equal(ready.marker, 'FLOKI_V2_NIGHT_CYCLE_SIMULATION_READY');
  assert.equal(ready.disabled_by_default, true,
    'the simulator must never run a night without an explicit mode flag');

  // --- Isolation is mandatory for every stateful path ---
  const sim = createNightCycleSimulation({ root, publish_latest: false });
  for (const key of SCOPED_PATH_KEYS) {
    assert.notEqual(
      path.resolve(String(sim.config[key])),
      path.resolve(String(production[key])),
      key + ' must never point at production during a simulation'
    );
    assert.ok(
      path.resolve(String(sim.config[key])).startsWith(path.resolve(root) + path.sep),
      key + ' must live under the simulation root'
    );
    assert.throws(
      () => createNightCycleSimulation({
        root,
        publish_latest: false,
        config_overrides: { [key]: production[key] }
      }),
      /refused to run/,
      'forcing ' + key + ' to production must refuse to run'
    );
  }

  // --- Virtual clock: forward-only, host clock untouched ---
  const clock = createSimClock('2026-07-06T23:00:30-04:00');
  const hostBefore = Date.now();
  const first = clock.now();
  clock.jumpTo(new Date(first.getTime() + 10 * 60000));
  assert.ok(clock.now().getTime() >= first.getTime() + 10 * 60000);
  assert.throws(() => clock.jumpTo(first), /forward/);
  assert.ok(Math.abs(Date.now() - hostBefore) < 60000,
    'the host clock must never be moved by the simulation');

  // --- Production schedule authority ---
  assert.equal(sim.sleep_window.start_hhmm, '23:00');
  assert.equal(sim.sleep_window.end_hhmm, '07:00');
  const tonight = getSleepWindowForDate(new Date());
  assert.equal(tonight.start_hhmm, '23:00',
    'the real production window derivation is unchanged');

  // --- Training-engine preflight: truthful version gating ---
  const oldEngine = preflightTrainingEngine(production, {
    spawnSync: fakeSpawn('podman version 4.9.3\n')
  });
  assert.equal(oldEngine.checked, true);
  assert.equal(oldEngine.ok, false, 'podman 4.x must be blocked for GPU training');
  assert.throws(
    () => assertTrainingEngineReady(production, {
      spawnSync: fakeSpawn('podman version 4.9.3\n')
    }),
    /FLOKI_V2_TRAINING_ENGINE_CDI_INCAPABLE/
  );
  const newEngine = preflightTrainingEngine(production, {
    spawnSync: fakeSpawn('podman version 6.0.0\n')
  });
  assert.equal(newEngine.ok, true);
  assert.equal(newEngine.major, 6);
  const fakeEngine = preflightTrainingEngine(production, {
    spawnSync: fakeSpawn('fake-engine-for-contract-tests\n')
  });
  assert.equal(fakeEngine.checked, false,
    'unparseable engines (contract-test fakes) skip the check');
  assert.equal(fakeEngine.ok, true);

  // --- CDI GPU probe: truthful pass/fail, no fabrication ---
  const probePass = cdiGpuProbe(sim.config, {
    spawnSync: fakeSpawn('GPU 0: NVIDIA GeForce RTX 3060 (UUID: GPU-x)\n')
  });
  assert.equal(probePass.ok, true);
  assert.match(probePass.gpu, /RTX 3060/);
  const probeFail = cdiGpuProbe(sim.config, {
    spawnSync: () => ({
      status: 125,
      stdout: '',
      stderr: 'Error: setting up CDI devices: unresolvable CDI devices nvidia.com/gpu=all',
      error: null
    })
  });
  assert.equal(probeFail.ok, false);
  assert.match(probeFail.error, /unresolvable CDI devices/);

  // --- UI status reader: only explicit simulation snapshots surface ---
  const uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'floki-night-sim-ui-'));
  const uiConfig = { project_root: uiRoot };
  assert.equal(readNightCycleSimulationStatus(uiConfig), null,
    'no snapshot file means no simulation status');
  const latestFile = path.join(uiRoot, 'state', 'floki', 'night-cycle-sim', 'latest.json');
  fs.mkdirSync(path.dirname(latestFile), { recursive: true });
  fs.writeFileSync(latestFile, JSON.stringify({ simulation: false, run_id: 'not-a-sim' }));
  assert.equal(readNightCycleSimulationStatus(uiConfig), null,
    'snapshots not marked simulation:true must never surface');
  fs.writeFileSync(latestFile, JSON.stringify({
    simulation: true,
    run_id: 'sim-contract',
    mode: 'paused',
    proof: { ok: true }
  }));
  const surfaced = readNightCycleSimulationStatus(uiConfig);
  assert.equal(surfaced.run_id, 'sim-contract');
  assert.equal(surfaced.simulation, true);

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_RSI_DAYTIME_NIGHT_CYCLE_SIMULATION_CONTRACT_PASS',
    scoped_keys: SCOPED_PATH_KEYS.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
