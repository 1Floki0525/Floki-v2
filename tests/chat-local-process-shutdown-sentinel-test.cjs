'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const {
  getSelfImprovementConfig,
  getVisionConfig
} = require('../src/config/floki-config.cjs');
const {
  cleanupOwnedProcesses,
  ownedProcessIds,
  readProcSnapshot,
  removeStaleRuntimeFiles,
  sshControlMasterOwned
} = require('../src/runtime/chat-local-cleanup-ownership.cjs');

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function sentinelCode() {
  return [
    "process.on('SIGTERM',()=>process.exit(0));",
    "process.on('SIGINT',()=>process.exit(0));",
    "process.on('SIGUSR1',()=>process.exit(0));",
    "if(process.env.FLOKI_SENTINEL_READY_FILE)",
    " require('node:fs').appendFileSync(process.env.FLOKI_SENTINEL_READY_FILE,process.pid+'\\n');",
    'setInterval(()=>{},1000);'
  ].join('');
}

function spawnSentinel(args, options = {}) {
  const env = {
    ...process.env,
    FLOKI_SENTINEL_READY_FILE: options.ready_file
  };
  if (options.argv0) {
    const command = [
      'exec -a',
      shellQuote(options.argv0),
      shellQuote(process.execPath),
      '-e',
      shellQuote(sentinelCode()),
      '--',
      ...args.map(shellQuote)
    ].join(' ');
    return spawn('bash', ['-lc', command], {
      cwd: options.cwd || ROOT,
      env,
      stdio: 'ignore'
    });
  }
  return spawn(process.execPath, ['-e', sentinelCode(), '--', ...args], {
    cwd: options.cwd || ROOT,
    env,
    stdio: 'ignore'
  });
}

async function waitForReady(file, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const count = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').trim().split(/\n/).filter(Boolean).length
      : 0;
    if (count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('sentinels did not become ready');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

async function waitForExit(child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!alive(child.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('sentinel survived cleanup: ' + child.pid);
}

function stop(child) {
  if (!child || !child.pid || !alive(child.pid)) return;
  try {
    child.kill('SIGTERM');
  } catch (_error) {
  }
}

async function main() {
  assert.match(process.version, /^v24\./);

  const rsi = getSelfImprovementConfig('chat');
  const vision = getVisionConfig('chat');
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'floki-cleanup-sentinel-')
  );
  const fakeRoot = path.join(tempRoot, 'repo');
  const chatRuntimeRoot = path.join(tempRoot, 'chat-runtime');
  const rsiRuntimeRoot = path.join(tempRoot, 'rsi-runtime');
  const modelProxyRoot = path.join(tempRoot, 'model-proxy');
  const tunnelSocket = path.join(chatRuntimeRoot, vision.vlm_ssh_tunnel_socket_name);
  const readyFile = path.join(tempRoot, 'ready');

  fs.mkdirSync(fakeRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(chatRuntimeRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(rsiRuntimeRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(modelProxyRoot, { recursive: true, mode: 0o700 });
  const staleFiles = [
    path.join(chatRuntimeRoot, 'chat-webcam-vision.pid'),
    path.join(chatRuntimeRoot, 'sleep-cycle-scheduler.pid'),
    path.join(chatRuntimeRoot, 'chat-local-runtime.pid'),
    path.join(chatRuntimeRoot, 'chat-mode-loop.stop'),
    path.join(chatRuntimeRoot, vision.vlm_ssh_tunnel_socket_name),
    path.join(rsiRuntimeRoot, rsi.worker_pid_file_name),
    path.join(rsiRuntimeRoot, rsi.run_request_file_name),
    path.join(rsiRuntimeRoot, rsi.current_container_file_name),
    path.join(modelProxyRoot, rsi.model_proxy_socket_name)
  ];
  for (const file of staleFiles) {
    fs.writeFileSync(file, 'stale-test-artifact\n', { mode: 0o600 });
  }

  const appRoot = path.join(fakeRoot, 'apps/floki-neural-interface');
  fs.mkdirSync(appRoot, { recursive: true, mode: 0o700 });
  const owned = [
    spawnSentinel([path.join(fakeRoot, 'src/runtime/chat-local-runtime.cjs')], { ready_file: readyFile }),
    spawnSentinel(['src/self-improvement/worker.cjs'], { ready_file: readyFile, cwd: fakeRoot }),
    spawnSentinel([path.join(fakeRoot, '.floki-tools/grounding-dino/grounding-dino-worker.py')], { ready_file: readyFile }),
    spawnSentinel([path.join(fakeRoot, '.floki-tools/yolo-config/yolo-worker.py')], { ready_file: readyFile }),
    spawnSentinel(['src/chat/sleep-cycle-scheduler.cjs', '--service'], { ready_file: readyFile, cwd: fakeRoot }),
    spawnSentinel([path.join(fakeRoot, '.floki-tools/repos/whisper.cpp/build/bin/whisper-server')], { ready_file: readyFile }),
    spawnSentinel([path.join(fakeRoot, '.floki-tools/venv-chat-embodiment/bin/piper')], { ready_file: readyFile }),
    spawnSentinel(['./node_modules/.bin/electron', '.'], { ready_file: readyFile, cwd: appRoot }),
    spawnSentinel([path.join(appRoot, 'node_modules/electron/dist/electron'), '.'], { ready_file: readyFile }),
    spawnSentinel([
      '-o',
      'BatchMode=yes',
      '-S',
      tunnelSocket,
      '-M',
      '-f',
      '-N',
      '-L',
      '127.0.0.1:11435:127.0.0.1:11434',
      vision.vlm_ssh_tunnel_target
    ], { ready_file: readyFile, argv0: 'ssh' })
  ];
  const preserved = [
    spawnSentinel(['serve'], { ready_file: readyFile, argv0: 'ollama' }),
    spawnSentinel(['--model', 'qwen-sentinel'], { ready_file: readyFile, argv0: 'llama-server' }),
    spawnSentinel(['unrelated-process'], { ready_file: readyFile, argv0: 'not-floki' })
  ];

  try {
    await waitForReady(readyFile, owned.length + preserved.length);

    const snapshot = readProcSnapshot('/proc');
    const selected = ownedProcessIds(snapshot, fakeRoot, {
      ssh_control_socket: tunnelSocket,
      ssh_control_target: vision.vlm_ssh_tunnel_target
    });
    for (const child of owned) {
      assert.equal(selected.has(child.pid), true, 'owned sentinel was not selected: ' + child.pid);
    }
    for (const child of preserved) {
      assert.equal(selected.has(child.pid), false, 'preserved sentinel was selected: ' + child.pid);
    }
    const sshInfo = snapshot.get(owned[owned.length - 1].pid);
    assert.equal(
      sshControlMasterOwned(sshInfo, {
        ssh_control_socket: tunnelSocket,
        ssh_control_target: vision.vlm_ssh_tunnel_target
      }),
      true
    );

    const cleanup = cleanupOwnedProcesses({
      root: fakeRoot,
      attempts: 40,
      poll_ms: 100,
      ssh_control_socket: tunnelSocket,
      ssh_control_target: vision.vlm_ssh_tunnel_target
    });
    assert.equal(cleanup.ok, true);

    for (const child of owned) await waitForExit(child);
    for (const child of preserved) {
      assert.equal(alive(child.pid), true, 'preserved sentinel was stopped: ' + child.pid);
    }

    removeStaleRuntimeFiles(staleFiles);
    for (const file of staleFiles) {
      assert.equal(fs.existsSync(file), false, 'stale file survived cleanup: ' + file);
    }

    const cleanupSource = fs.readFileSync(
      path.join(ROOT, 'bin/floki-chat-local-cleanup.sh'),
      'utf8'
    );
    assert.match(cleanupSource, /ssh -S "\$VISION_SSH_TUNNEL_SOCKET" -O exit "\$VISION_SSH_TUNNEL_TARGET"/);
    assert.match(cleanupSource, /chat-local-cleanup-ownership\.cjs/);
    assert.match(cleanupSource, /removeStaleRuntimeFiles/);
  } finally {
    for (const child of [...owned, ...preserved]) stop(child);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    marker: 'FLOKI_V2_CHAT_LOCAL_PROCESS_SHUTDOWN_SENTINEL_PASS',
    floki_owned_sentinels_stopped: owned.length,
    ollama_qwen_sentinels_preserved: true,
    stale_runtime_files_removed: true,
    ssh_control_master_selected: true
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
