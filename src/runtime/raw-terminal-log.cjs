
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT, getPathConfig } = require('../config/floki-config.cjs');

function inside(root, target) {
  if (!root || !target) return false;
  const base = path.resolve(root);
  const file = path.resolve(target);
  return file === base || file.startsWith(base + path.sep);
}

function statFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch (_error) {
    return null;
  }
}

function latestNamedLog(root, names) {
  if (!root || !fs.existsSync(root)) return null;
  const wanted = new Set(names);
  let best = null;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch (_error) { continue; }
    for (const entry of entries) {
      const file = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < 2) {
        queue.push({ dir: file, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !wanted.has(entry.name)) continue;
      const stat = statFile(file);
      if (stat && (!best || stat.mtimeMs > best.stat.mtimeMs)) best = { file, stat };
    }
  }
  return best && best.file || null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_error) { return null; }
}

function selectRawTerminalSource(options = {}) {
  const config = options.config;
  const status = options.status || {};
  const session = options.session || null;
  const chatRuntimeConfigured = getPathConfig('chat').chat_runtime_root;
  const chatRuntimeRoot = path.isAbsolute(chatRuntimeConfigured)
    ? chatRuntimeConfigured
    : path.resolve(PROJECT_ROOT, chatRuntimeConfigured);
  const allowedRoots = [
    config.workspace_root,
    config.training_runtime_root,
    config.runtime_root,
    chatRuntimeRoot
  ].filter(Boolean).map((value) => path.resolve(value));
  const remActivity = readJson(path.join(config.training_runtime_root, 'hf-rem-active.json'));
  const candidates = [];
  const push = (kind, file, active, runId) => {
    if (!file) return;
    const resolved = path.resolve(file);
    if (!allowedRoots.some((root) => inside(root, resolved))) return;
    const stat = statFile(resolved);
    if (!stat) return;
    candidates.push({ kind, file: resolved, stat, active: active === true, run_id: runId || null });
  };

  if (remActivity) push('nightly_rem', remActivity.log_file, true, session && session.run_id);
  if (session && session.runtime) {
    push('nightly_training', session.runtime.log_file, session.active === true && session.finalized !== true, session.run_id);
  }
  if (status.current_run_kind === 'code') {
    push('code', status.last_sandbox_log_file, Boolean(status.current_run_id), status.current_run_id);
  }
  if (!candidates.some((row) => row.kind.startsWith('nightly_'))) {
    push('nightly_training', latestNamedLog(config.training_runtime_root, [config.training_log_file_name || 'training.log']), false, session && session.run_id);
  }
  if (!candidates.some((row) => row.kind === 'code')) {
    push('code', status.last_sandbox_log_file, Boolean(status.current_run_id), status.current_run_id);
  }

  if (!candidates.some((row) => row.kind.startsWith('nightly_'))) {
    const scheduler = latestNamedLog(chatRuntimeRoot, [
      'sleep-cycle-scheduler.log',
      'nightly-training-scheduler.log',
      'scheduler.log'
    ]);
    push('scheduler_fallback', scheduler, false, null);
  }

  if (candidates.length === 0) return null;
  const decorated = candidates.map((row) => Object.freeze({
    ...row,
    source_id: crypto.createHash('sha256')
      .update(row.file)
      .update('\0' + String(row.stat.dev))
      .update('\0' + String(row.stat.ino))
      .digest('hex')
  }));
  const requested = String(options.requested_source_id || '').trim();
  if (requested) {
    const pinned = decorated.find((row) => row.source_id === requested);
    if (pinned) return pinned;
  }
  const priority = (row) => {
    if (row.active && row.kind === 'nightly_rem') return 0;
    if (row.active && row.kind === 'nightly_training') return 1;
    if (row.active && row.kind === 'code') return 2;
    if (row.kind === 'nightly_rem') return 3;
    if (row.kind === 'nightly_training') return 4;
    if (row.kind === 'code') return 5;
    return 6;
  };
  decorated.sort((left, right) => {
    const byPriority = priority(left) - priority(right);
    return byPriority !== 0 ? byPriority : right.stat.mtimeMs - left.stat.mtimeMs;
  });
  return decorated[0];
}

async function readBoundedBytes(file, start, length) {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function readRawTerminal(options = {}) {
  const source = options.source || selectRawTerminalSource(options);
  if (!source) {
    return Object.freeze({
      ok: true,
      source_id: null,
      source_kind: null,
      run_id: null,
      terminal_file: null,
      cursor: 0,
      next_cursor: 0,
      file_size: 0,
      has_older: false,
      has_newer: false,
      text: '',
      active: false,
      completed: false
    });
  }
  const current = fs.statSync(source.file);
  const size = current.size;
  const maxBytes = Math.min(262144, Math.max(4096, Number(options.max_bytes || 65536)));
  const before = Number.isSafeInteger(Number(options.before_cursor))
    ? Math.max(0, Math.min(size, Number(options.before_cursor)))
    : null;
  let start;
  let end;
  if (before !== null) {
    end = before;
    start = Math.max(0, end - maxBytes);
  } else {
    start = Number.isSafeInteger(Number(options.cursor))
      ? Math.max(0, Math.min(size, Number(options.cursor)))
      : 0;
    end = Math.min(size, start + maxBytes);
  }
  const buffer = await readBoundedBytes(source.file, start, Math.max(0, end - start));
  const actualEnd = start + buffer.length;
  return Object.freeze({
    ok: true,
    source_id: source.source_id,
    source_kind: source.kind,
    run_id: source.run_id,
    terminal_file: source.file,
    cursor: start,
    next_cursor: actualEnd,
    file_size: size,
    has_older: start > 0,
    has_newer: actualEnd < size,
    text: buffer.toString('utf8'),
    active: source.active === true,
    completed: source.active !== true
  });
}

module.exports = {
  inside,
  latestNamedLog,
  readBoundedBytes,
  readRawTerminal,
  selectRawTerminalSource,
  statFile
};
