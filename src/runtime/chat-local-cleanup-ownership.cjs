'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMPONENT_PATHS = Object.freeze([
  'src/vision/chat-webcam-vision-service.cjs',
  '.floki-tools/yolo-config/yolo-worker.py',
  '.floki-tools/grounding-dino/grounding-dino-worker.py',
  'src/chat/sleep-cycle-scheduler.cjs',
  'src/runtime/chat-local-runtime.cjs',
  'src/senses/chat-mode-loop.cjs',
  'src/senses/silero-vad-worker.py',
  '.floki-tools/repos/whisper.cpp/build/bin/whisper-cli',
  '.floki-tools/repos/whisper.cpp/build/bin/whisper-server',
  '.floki-tools/venv-chat-embodiment/bin/piper',
  'src/self-improvement/worker.cjs',
  'src/self-improvement/promoter.cjs',
  'apps/floki-neural-interface/node_modules/.bin/electron',
  'apps/floki-neural-interface/node_modules/electron/dist/electron',
  'apps/floki-neural-interface/node_modules/electron/cli.js'
]);

function componentArgs(root) {
  const resolvedRoot = path.resolve(root);
  const values = new Set(COMPONENT_PATHS);
  for (const relative of COMPONENT_PATHS) {
    values.add(path.join(resolvedRoot, relative));
  }
  return values;
}

function readProcSnapshot(procRoot = '/proc') {
  const processes = new Map();
  for (const entry of fs.readdirSync(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === process.pid || pid === process.ppid) continue;
    const base = path.join(procRoot, entry.name);
    try {
      const argv = fs.readFileSync(path.join(base, 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      const status = fs.readFileSync(path.join(base, 'status'), 'utf8');
      const ppidMatch = status.match(/^PPid:\s+(\d+)/m);
      let cwd = null;
      try {
        cwd = fs.readlinkSync(path.join(base, 'cwd'));
      } catch (_cwdError) {
      }
      processes.set(pid, Object.freeze({
        pid,
        ppid: ppidMatch ? Number(ppidMatch[1]) : 0,
        argv,
        cwd,
        cmdline: argv.join(' ')
      }));
    } catch (_error) {
    }
  }
  return processes;
}

function sshControlMasterOwned(info, options = {}) {
  const socket = options.ssh_control_socket;
  const target = options.ssh_control_target;
  if (!socket || !target) return false;
  if (path.basename(info.argv[0] || '') !== 'ssh') return false;
  return info.argv.includes('-S') &&
    info.argv.includes(socket) &&
    info.argv.includes('-M') &&
    info.argv.includes(target);
}

function ownedProcessIds(processes, root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const args = componentArgs(root);
  const targets = new Set();
  for (const [pid, info] of processes) {
    const normalizedArgs = info.argv.map((arg) => {
      if (args.has(arg)) return arg;
      if (arg.startsWith('./') && info.cwd) return path.resolve(info.cwd, arg);
      if (arg.startsWith('../') && info.cwd) return path.resolve(info.cwd, arg);
      return arg;
    });
    const cwdInsideRepo =
      info.cwd === resolvedRoot ||
      (typeof info.cwd === 'string' && info.cwd.startsWith(resolvedRoot + path.sep));
    const electronAppLaunch =
      cwdInsideRepo &&
      normalizedArgs.some((arg) => args.has(arg)) &&
      info.argv.includes('.');
    if (
      normalizedArgs.some((arg) => args.has(arg)) ||
      electronAppLaunch ||
      sshControlMasterOwned(info, options)
    ) {
      targets.add(pid);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, info] of processes) {
      if (targets.has(info.ppid) && !targets.has(pid)) {
        targets.add(pid);
        changed = true;
      }
    }
  }
  return targets;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanupOwnedProcesses(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const procRoot = options.proc_root || '/proc';
  const attempts = Number.isInteger(options.attempts)
    ? options.attempts
    : 40;
  const pollMs = Number.isFinite(options.poll_ms)
    ? options.poll_ms
    : 250;
  const killFn = options.kill || process.kill;
  const killed = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const processes = readProcSnapshot(procRoot);
    const targets = ownedProcessIds(processes, root, options);
    if (targets.size === 0) break;
    for (const pid of Array.from(targets).sort((a, b) => b - a)) {
      try {
        killFn(pid, 'SIGTERM');
        killed.push({ pid, signal: 'SIGTERM' });
      } catch (_error) {
      }
    }
    sleep(pollMs);
  }

  const afterTerm = readProcSnapshot(procRoot);
  const remaining = ownedProcessIds(afterTerm, root, options);
  for (const pid of Array.from(remaining).sort((a, b) => b - a)) {
    try {
      killFn(pid, 'SIGKILL');
      killed.push({ pid, signal: 'SIGKILL' });
    } catch (_error) {
    }
  }
  if (remaining.size > 0) sleep(pollMs);

  const finalSnapshot = readProcSnapshot(procRoot);
  const survivors = Array.from(ownedProcessIds(finalSnapshot, root, options))
    .filter(processAlive)
    .map((pid) => finalSnapshot.get(pid))
    .filter(Boolean);

  return Object.freeze({
    ok: survivors.length === 0,
    killed,
    survivors
  });
}

function removeStaleRuntimeFiles(files = []) {
  const removed = [];
  for (const file of files) {
    const target = String(file || '').trim();
    if (!target) continue;
    fs.rmSync(target, { force: true });
    removed.push(target);
  }
  return Object.freeze(removed);
}

function main(argv = process.argv.slice(2)) {
  const [
    root,
    attemptsText,
    pollSecondsText,
    sshControlSocket,
    sshControlTarget
  ] = argv;
  const result = cleanupOwnedProcesses({
    root,
    attempts: Number(attemptsText),
    poll_ms: Math.max(0, Number(pollSecondsText) * 1000),
    ssh_control_socket: sshControlSocket || null,
    ssh_control_target: sshControlTarget || null
  });
  for (const survivor of result.survivors) {
    process.stderr.write(
      'FLOKI_CHAT_LOCAL_CLEANUP_SURVIVOR ' +
      'pid=' + survivor.pid +
      ' ppid=' + survivor.ppid +
      ' cmd=' + survivor.cmdline +
      os.EOL
    );
  }
  if (!result.ok) process.exit(1);
  process.stdout.write('FLOKI_CHAT_LOCAL_EXACT_CLEANUP_PASS' + os.EOL);
}

if (require.main === module) {
  main();
}

module.exports = {
  COMPONENT_PATHS,
  cleanupOwnedProcesses,
  componentArgs,
  ownedProcessIds,
  readProcSnapshot,
  removeStaleRuntimeFiles,
  sshControlMasterOwned
};
