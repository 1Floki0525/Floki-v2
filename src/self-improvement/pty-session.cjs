'use strict';

// One genuine persistent PTY per RSI run. The shell is a real interactive
// bash on a pseudo-terminal (allocated by util-linux `script`) and every agent
// shell command is typed into this same session. `cd`, exported variables,
// shell options, prompt state, and the foreground process therefore persist
// exactly as they do in a human terminal.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SENTINEL_BYTE = 0x1f;
const SENTINEL_TAG = 'FLOKI_RSI_CMD_DONE';
const START_TAG = 'FLOKI_RSI_CMD_START';
const READY_TAG = 'FLOKI_RSI_PTY_READY';

function requirePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('pty session requires a positive YAML-derived ' + name);
  }
  return parsed;
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()][0-2A-Z0-9]/g, '');
}

function normalizeCapturedOutput(buffer) {
  return stripAnsi(buffer.toString('utf8'))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\n+|\n+$/g, '');
}

function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function createPtySession(options = {}) {
  const streamFile = String(options.stream_file || '');
  if (!streamFile) throw new Error('pty session requires stream_file');
  const cwd = String(options.cwd || process.cwd());
  const env = options.env && typeof options.env === 'object'
    ? options.env
    : process.env;
  const rows = requirePositiveNumber(options.rows, 'pty_rows');
  const cols = requirePositiveNumber(options.cols, 'pty_cols');
  const streamMaxBytes = requirePositiveNumber(
    options.stream_max_bytes,
    'terminal_stream_max_bytes'
  );
  const outputMaxBytes = requirePositiveNumber(
    options.output_max_bytes || streamMaxBytes,
    'agent_shell_output_buffer_bytes'
  );
  const sentinelGraceMs = requirePositiveNumber(
    options.sentinel_grace_ms,
    'terminal_sentinel_grace_ms'
  );
  const interruptGraceMs = requirePositiveNumber(
    options.interrupt_grace_ms,
    'terminal_interrupt_grace_ms'
  );
  const onEvent = typeof options.on_event === 'function'
    ? options.on_event
    : () => {};
  const shellCommand = String(
    options.shell_command || 'bash --noprofile --norc -i'
  );
  const prompt = String(options.prompt || '\\u@\\h:${PWD}$ ');

  let child = null;
  let closed = false;
  let streamBytes = 0;
  let streamTruncated = false;
  let pendingLine = Buffer.alloc(0);
  let activeCommand = null;
  let lastKnownPwd = cwd;
  let sessionGeneration = 0;
  let readyPromise = null;
  let readyResolve = null;
  let readyReject = null;
  let readyNonce = null;
  let readyTimer = null;

  fs.mkdirSync(path.dirname(streamFile), {
    recursive: true,
    mode: 0o700
  });
  fs.writeFileSync(streamFile, '', { mode: 0o600 });

  function appendStream(buffer) {
    if (!buffer || buffer.length === 0) return;
    const start = streamBytes;
    if (streamBytes >= streamMaxBytes) {
      if (!streamTruncated) {
        streamTruncated = true;
        onEvent('stream_bound_reached', { bytes: streamBytes });
      }
      return;
    }
    const room = streamMaxBytes - streamBytes;
    const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
    try {
      fs.appendFileSync(streamFile, slice);
    } catch (error) {
      onEvent('stream_write_error', {
        error: error.message,
        stream_file: streamFile
      });
      return;
    }
    streamBytes += slice.length;
    onEvent('stream_chunk', {
      sequence_start: start,
      sequence_end: streamBytes,
      bytes: slice.length
    });
  }

  function writeActivity(value) {
    if (closed) return false;
    const text = stripAnsi(String(value || ''))
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 320);
    if (!text) return false;
    const line = Buffer.from(
      '\r\n\u001b[2m[RSI] ' + new Date().toISOString() + ' ' +
      text + '\u001b[0m\r\n',
      'utf8'
    );
    appendStream(line);
    onEvent('activity_line', {
      text,
      bytes: line.length
    });
    return true;
  }

  function captureVisible(buffer) {
    if (
      !activeCommand ||
      activeCommand.capturing !== true ||
      !buffer ||
      buffer.length === 0
    ) return;
    const remaining = outputMaxBytes - activeCommand.outputBytes;
    if (remaining <= 0) {
      activeCommand.outputTruncated = true;
      return;
    }
    const slice = buffer.length > remaining
      ? buffer.subarray(0, remaining)
      : buffer;
    activeCommand.outputChunks.push(slice);
    activeCommand.outputBytes += slice.length;
    if (slice.length < buffer.length) activeCommand.outputTruncated = true;
  }

  function emitVisible(buffer) {
    appendStream(buffer);
    captureVisible(buffer);
  }

  function isControlLine(line) {
    if (line.includes(SENTINEL_BYTE)) return true;
    const text = line.toString('utf8');
    return text.includes("printf '\\037" + SENTINEL_TAG) ||
      text.includes("printf '\\037" + READY_TAG) ||
      text.includes('\\037' + SENTINEL_TAG) ||
      text.includes('\\037' + READY_TAG);
  }

  function resolveReady(pwd) {
    if (!readyResolve) return;
    clearTimeout(readyTimer);
    readyTimer = null;
    lastKnownPwd = pwd || lastKnownPwd;
    const resolve = readyResolve;
    readyResolve = null;
    readyReject = null;
    readyNonce = null;
    setTimeout(resolve, 25);
  }

  function rejectReady(error) {
    if (!readyReject) return;
    clearTimeout(readyTimer);
    readyTimer = null;
    const reject = readyReject;
    readyResolve = null;
    readyReject = null;
    readyNonce = null;
    reject(error);
  }

  function handleControlScan(line) {
    if (!line.includes(SENTINEL_BYTE)) return;
    const text = line.toString('utf8');
    const readyPattern = new RegExp(
      '\\x1f' + READY_TAG + ' (\\S+) ([^\\x1f]*)\\x1f'
    );
    const readyMatch = text.match(readyPattern);
    if (readyMatch && readyNonce && readyMatch[1] === readyNonce) {
      resolveReady(readyMatch[2] || null);
      return;
    }

    const startPattern = new RegExp(
      '\\x1f' + START_TAG + ' (\\S+)\\x1f'
    );
    const startMatch = text.match(startPattern);
    if (
      startMatch &&
      activeCommand &&
      activeCommand.nonce === startMatch[1]
    ) {
      activeCommand.capturing = true;
      return;
    }

    const donePattern = new RegExp(
      '\\x1f' + SENTINEL_TAG + ' (\\S+) (\\d+) ([^\\x1f]*)\\x1f'
    );
    const doneMatch = text.match(donePattern);
    if (!doneMatch) return;
    const [, nonce, status, pwd] = doneMatch;
    if (!activeCommand || activeCommand.nonce !== nonce) return;
    lastKnownPwd = pwd || lastKnownPwd;
    const command = activeCommand;
    activeCommand = null;
    command.finish({
      status: Number(status),
      pwd: pwd || null
    });
  }

  function feed(buffer) {
    const data = Buffer.concat([pendingLine, buffer]);
    let start = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue;
      const line = data.subarray(start, index + 1);
      start = index + 1;
      if (isControlLine(line)) handleControlScan(line);
      else emitVisible(line);
    }
    pendingLine = data.subarray(start);
    if (
      pendingLine.length > 0 &&
      !pendingLine.includes(SENTINEL_BYTE) &&
      !pendingLine.toString('utf8').includes("printf '\\037")
    ) {
      emitVisible(pendingLine);
      pendingLine = Buffer.alloc(0);
    }
  }

  function shellAlive() {
    return child !== null && child.exitCode === null && !child.killed;
  }

  function killShellGroup(signal) {
    if (!child) return;
    try {
      process.kill(-child.pid, signal);
    } catch (_error) {
      try { child.kill(signal); } catch (_fallback) {}
    }
  }

  function startShell() {
    sessionGeneration += 1;
    readyNonce = crypto.randomBytes(9).toString('hex');
    readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    child = spawn('script', ['-qfc', shellCommand, '/dev/null'], {
      cwd,
      env: {
        ...env,
        TERM: 'xterm-256color',
        LINES: String(rows),
        COLUMNS: String(cols),
        PS1: prompt,
        PROMPT_COMMAND: ''
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.once('error', (error) => {
      rejectReady(error);
    });
    child.once('close', (code, signal) => {
      rejectReady(new Error(
        'pty shell closed before readiness: code=' + String(code) +
        ' signal=' + String(signal)
      ));
      if (activeCommand) {
        const command = activeCommand;
        activeCommand = null;
        command.finish({
          status: null,
          pty_closed: true,
          close_code: code,
          close_signal: signal
        });
      }
      onEvent('pty_closed', {
        generation: sessionGeneration,
        code,
        signal,
        intentional: closed
      });
    });
    onEvent('pty_opened', {
      generation: sessionGeneration,
      pid: child.pid,
      stream_file: streamFile
    });
    const quotedPrompt = prompt.replace(/'/g, "'\\''");
    child.stdin.write(
      'stty -echo rows ' + rows + ' cols ' + cols +
      "; export PS1='" + quotedPrompt + "'" +
      "; export PROMPT_COMMAND=''" +
      "; printf '\\037" + READY_TAG + " %s %s\\037\\n' '" +
      readyNonce + "' \"$PWD\"\n"
    );
    readyTimer = setTimeout(() => {
      const error = new Error('pty shell readiness timed out');
      rejectReady(error);
      killShellGroup('SIGKILL');
    }, sentinelGraceMs);
  }

  async function ensureReady() {
    if (!shellAlive()) startShell();
    if (readyPromise) await readyPromise;
  }

  async function run(command, options2 = {}) {
    if (closed) throw new Error('pty session is closed');
    if (activeCommand) {
      throw new Error('pty session already has an active command');
    }
    await ensureReady();

    const timeoutMs = requirePositiveNumber(options2.timeout_ms, 'timeout_ms');
    const signal = options2.signal || null;
    const commandText = String(command || '');
    const nonce = crypto.randomBytes(9).toString('hex');
    const started = Date.now();
    const generationAtStart = sessionGeneration;

    return new Promise((resolve) => {
      let timedOut = false;
      let cancelled = false;
      let interruptTimer = null;
      let killTimer = null;
      let timeoutTimer = null;
      let abortListener = null;

      function cleanupTimers() {
        clearTimeout(interruptTimer);
        clearTimeout(killTimer);
        clearTimeout(timeoutTimer);
        if (signal && abortListener) {
          signal.removeEventListener('abort', abortListener);
        }
      }

      function escalate(reason) {
        try { child.stdin.write('\x03'); } catch (_error) {}
        interruptTimer = setTimeout(() => {
          if (activeCommand && activeCommand.nonce === nonce) {
            killTimer = setTimeout(() => {
              if (activeCommand && activeCommand.nonce === nonce) {
                onEvent('pty_session_killed', { reason, nonce });
                killShellGroup('SIGKILL');
              }
            }, interruptGraceMs);
          }
        }, interruptGraceMs);
      }

      activeCommand = {
        nonce,
        capturing: false,
        outputChunks: [],
        outputBytes: 0,
        outputTruncated: false,
        finish(detail) {
          cleanupTimers();
          const output = normalizeCapturedOutput(
            Buffer.concat(this.outputChunks)
          );
          resolve(Object.freeze({
            status: detail.status,
            duration_ms: Date.now() - started,
            timed_out: timedOut,
            cancelled,
            pty_generation: generationAtStart,
            pty_replaced: sessionGeneration !== generationAtStart ||
              detail.pty_closed === true,
            pwd: detail.pwd || lastKnownPwd,
            stdout: output,
            stderr: '',
            pty_merged_output: true,
            output_truncated: this.outputTruncated
          }));
        }
      };

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        escalate('timeout');
      }, timeoutMs);

      if (signal) {
        abortListener = () => {
          cancelled = true;
          escalate('cancelled');
        };
        if (signal.aborted) abortListener();
        else signal.addEventListener('abort', abortListener, { once: true });
      }

      const encodedCommand = Buffer.from(commandText, 'utf8').toString('base64');
      const wrapper = [
        '__floki_cmd="$(printf %s ' + shellSingleQuote(encodedCommand) + ' | base64 -d)"',
        "printf '%s\\n' \"$__floki_cmd\"",
        "printf '\\037" + START_TAG + " %s\\037\\n' " + shellSingleQuote(nonce),
        'eval "$__floki_cmd"',
        '__floki_status=$?',
        "printf '\\037" + SENTINEL_TAG + " %s %s %s\\037\\n' " +
          shellSingleQuote(nonce) + ' "$__floki_status" "$PWD"',
        'unset __floki_cmd __floki_status'
      ].join('; ');
      child.stdin.write(wrapper + '\n');
    });
  }

  function close(reason = 'run_ended') {
    if (closed) return;
    closed = true;
    clearTimeout(readyTimer);
    readyTimer = null;
    if (pendingLine.length > 0 && !pendingLine.includes(SENTINEL_BYTE)) {
      emitVisible(pendingLine);
      pendingLine = Buffer.alloc(0);
    }
    appendStream(Buffer.from(
      '\r\n[terminal session closed: ' + reason + ']\r\n'
    ));
    if (shellAlive()) {
      try {
        child.stdin.write('exit\n');
        child.stdin.end();
      } catch (_error) {}
      setTimeout(() => {
        if (!shellAlive()) return;
        killShellGroup('SIGTERM');
        setTimeout(() => {
          if (shellAlive()) killShellGroup('SIGKILL');
        }, interruptGraceMs).unref();
      }, sentinelGraceMs).unref();
    }
    onEvent('pty_session_closed', {
      reason,
      stream_bytes: streamBytes
    });
  }

  return Object.freeze({
    run,
    writeActivity,
    close,
    stream_file: streamFile,
    get pwd() { return lastKnownPwd; },
    get alive() { return shellAlive(); },
    get stream_bytes() { return streamBytes; }
  });
}

module.exports = {
  READY_TAG,
  SENTINEL_TAG,
  START_TAG,
  createPtySession,
  normalizeCapturedOutput,
  stripAnsi
};
