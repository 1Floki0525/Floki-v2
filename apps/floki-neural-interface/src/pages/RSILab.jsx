import React, { useCallback, useEffect, useRef, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import SelfImprovementPanel from '@/components/system/SelfImprovementPanel'
import ReadOnlyXtermTerminal from '@/components/rsi/ReadOnlyXtermTerminal'
import flokiAdapter from '@/integrations/floki/adapter'

// Seed values used only until the first status response delivers the
// YAML-authoritative ui_limits (rsi_terminal_* keys in chat.config.yaml).
const TERMINAL_BOOTSTRAP_LIMITS = Object.freeze({
  chunk_bytes: 64 * 1024,
  window_bytes: 2 * 1024 * 1024,
  poll_ms: 1000
})

// before_cursor is clamped to the file size by the backend, so the largest
// safe integer always requests the newest bounded tail of the stream.
const TERMINAL_TAIL_CURSOR = Number.MAX_SAFE_INTEGER

function terminalLimit(uiLimits, key, bootstrap) {
  const configured = Number(uiLimits?.[key])
  return Number.isFinite(configured) && configured > 0 ? configured : bootstrap
}

function terminalPollMs(uiLimits) {
  return terminalLimit(
    uiLimits,
    'terminal_poll_ms',
    terminalLimit(
      uiLimits,
      'terminal_bootstrap_poll_ms',
      TERMINAL_BOOTSTRAP_LIMITS.poll_ms
    )
  )
}

function terminalChunkBytes(uiLimits) {
  return terminalLimit(
    uiLimits,
    'terminal_chunk_bytes',
    TERMINAL_BOOTSTRAP_LIMITS.chunk_bytes
  )
}

function terminalWindowBytes(uiLimits) {
  return terminalLimit(
    uiLimits,
    'terminal_window_bytes',
    TERMINAL_BOOTSTRAP_LIMITS.window_bytes
  )
}

// Raw PTY sources deliver base64 bytes; plain log sources deliver utf8 text.
// Both become a Uint8Array written to xterm without any sanitization.
function decodeTerminalBytes(payload) {
  if (payload?.encoding === 'base64' && payload.data_base64) {
    const binary = atob(String(payload.data_base64))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }
  return new TextEncoder().encode(String(payload?.text || ''))
}

function chunkFromPayload(payload, bytes) {
  return Object.freeze({
    start: Number(payload.cursor || 0),
    end: Number(payload.next_cursor || 0),
    bytes
  })
}

function windowByteTotal(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0)
}

// Bound the replay window from the oldest side as the append poll grows it.
function boundChunksFromStart(chunks, maxBytes) {
  let total = windowByteTotal(chunks)
  let index = 0
  while (index < chunks.length - 1 && total > maxBytes) {
    total -= chunks[index].bytes.length
    index += 1
  }
  return { chunks: index > 0 ? chunks.slice(index) : chunks, dropped: index > 0 }
}

// Bound the replay window from the newest side when Load Older grows it; any
// dropped tail bytes are re-fetched by the append poll from the new end
// cursor, so no output is lost.
function boundChunksFromEnd(chunks, maxBytes) {
  let total = windowByteTotal(chunks)
  let endIndex = chunks.length
  while (endIndex > 1 && total > maxBytes) {
    total -= chunks[endIndex - 1].bytes.length
    endIndex -= 1
  }
  return {
    chunks: endIndex < chunks.length ? chunks.slice(0, endIndex) : chunks,
    dropped: endIndex < chunks.length
  }
}

function emptyTerminalState(revision = 0) {
  return {
    sourceId: /** @type {string | null} */ (null),
    sourceKind: /** @type {string | null} */ (null),
    runId: /** @type {string | null} */ (null),
    startCursor: 0,
    endCursor: 0,
    fileSize: 0,
    hasOlder: false,
    active: false,
    revision,
    revisionKind: /** @type {string} */ ('reset'),
    chunks: /** @type {Array<{ start: number, end: number, bytes: Uint8Array }>} */ ([])
  }
}

function RSITerminal() {
  const [terminal, setTerminal] = useState(() => emptyTerminalState());
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [following, setFollowing] = useState(true);
  const terminalRef = useRef(terminal);
  const uiLimitsRef = useRef(null);
  const xtermRef = useRef(null);

  useEffect(() => {
    terminalRef.current = terminal;
  }, [terminal]);

  const applyChunk = useCallback((payload, mode = 'append') => {
    if (!payload || payload.ok !== true) return;
    setTerminal((current) => {
      const windowBytes = terminalWindowBytes(uiLimitsRef.current);
      if (mode === 'reset') {
        if (!payload.source_id) {
          // No selectable source: keep showing empty state, but only bump
          // the revision when an existing source actually disappeared.
          return current.sourceId
            ? emptyTerminalState(current.revision + 1)
            : current;
        }
        const bytes = decodeTerminalBytes(payload);
        return {
          sourceId: payload.source_id,
          sourceKind: payload.source_kind || null,
          runId: payload.run_id || null,
          startCursor: Number(payload.cursor || 0),
          endCursor: Number(payload.next_cursor || 0),
          fileSize: Number(payload.file_size || 0),
          hasOlder: payload.has_older === true,
          active: payload.active === true,
          revision: current.revision + 1,
          revisionKind: 'reset',
          chunks: bytes.length > 0 ? [chunkFromPayload(payload, bytes)] : []
        };
      }
      if (!current.sourceId || payload.source_id !== current.sourceId) {
        return current;
      }
      if (mode === 'older') {
        const bytes = decodeTerminalBytes(payload);
        if (bytes.length === 0) {
          return { ...current, hasOlder: payload.has_older === true };
        }
        const grown = [chunkFromPayload(payload, bytes), ...current.chunks];
        const bounded = boundChunksFromEnd(grown, windowBytes);
        const lastChunk = bounded.chunks[bounded.chunks.length - 1];
        return {
          ...current,
          startCursor: Number(payload.cursor || 0),
          endCursor: lastChunk ? lastChunk.end : Number(payload.next_cursor || 0),
          fileSize: Number(payload.file_size || current.fileSize),
          hasOlder: payload.has_older === true,
          active: payload.active === true,
          revision: current.revision + 1,
          revisionKind: 'older',
          chunks: bounded.chunks
        };
      }
      if (Number(payload.cursor) !== current.endCursor) {
        return current;
      }
      const bytes = decodeTerminalBytes(payload);
      if (bytes.length === 0) {
        return {
          ...current,
          fileSize: Number(payload.file_size || current.fileSize),
          hasOlder: current.hasOlder || payload.has_older === true,
          active: payload.active === true
        };
      }
      const grown = [...current.chunks, chunkFromPayload(payload, bytes)];
      const bounded = boundChunksFromStart(grown, windowBytes);
      return {
        ...current,
        sourceKind: payload.source_kind || current.sourceKind,
        runId: payload.run_id || current.runId,
        startCursor: bounded.chunks[0] ? bounded.chunks[0].start : current.startCursor,
        endCursor: Number(payload.next_cursor || current.endCursor),
        fileSize: Number(payload.file_size || current.fileSize),
        hasOlder: current.hasOlder || bounded.dropped || payload.has_older === true,
        active: payload.active === true,
        chunks: bounded.chunks
      };
    });
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    const poll = async () => {
      try {
        const current = terminalRef.current;
        const request = current.sourceId
          ? { cursor: current.endCursor, max_bytes: terminalChunkBytes(uiLimitsRef.current) }
          : { before_cursor: TERMINAL_TAIL_CURSOR, max_bytes: terminalChunkBytes(uiLimitsRef.current) };
        let [payload, nextStatus] = await Promise.all([
          flokiAdapter.getSelfImprovementTerminal(request),
          flokiAdapter.getSelfImprovementStatus()
        ]);
        if (stopped) return;
        let mode = current.sourceId ? 'append' : 'reset';
        const sourceSwitched = Boolean(
          current.sourceId &&
          payload?.source_id &&
          payload.source_id !== current.sourceId
        );
        const cursorDiscontinuity = Boolean(
          mode === 'append' &&
          !sourceSwitched &&
          payload?.ok === true &&
          Number(payload.cursor) !== current.endCursor
        );
        if (sourceSwitched || cursorDiscontinuity) {
          // Reset and reload the newest bounded tail: either the backend
          // switched sources or the byte stream is no longer continuous
          // (for example the file was truncated in place).
          payload = await flokiAdapter.getSelfImprovementTerminal({
            before_cursor: TERMINAL_TAIL_CURSOR,
            max_bytes: terminalChunkBytes(uiLimitsRef.current)
          });
          if (stopped) return;
          mode = 'reset';
        }
        applyChunk(payload, mode);
        if (nextStatus?.ui_limits) uiLimitsRef.current = nextStatus.ui_limits;
        setStatus(nextStatus);
        setError('');
      } catch (pollError) {
        if (!stopped) setError(pollError?.message || String(pollError));
      } finally {
        if (!stopped) timer = setTimeout(poll, terminalPollMs(uiLimitsRef.current));
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [applyChunk]);

  const loadOlder = useCallback(async () => {
    if (!terminalRef.current.hasOlder || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const current = terminalRef.current;
      const payload = await flokiAdapter.getSelfImprovementTerminal({
        before_cursor: current.startCursor,
        max_bytes: terminalChunkBytes(uiLimitsRef.current),
        source_id: current.sourceId
      });
      applyChunk(payload, 'older');
      setError('');
    } catch (loadError) {
      setError(loadError?.message || String(loadError));
    } finally {
      setLoadingOlder(false);
    }
  }, [applyChunk, loadingOlder]);

  const abortTraining = useCallback(async () => {
    setAborting(true);
    try {
      const result = await flokiAdapter.abortSelfImprovement(
        'training',
        'maker_abort_training'
      );
      if (!result || result.verified !== true) {
        throw new Error(result?.error || 'Training abort was not verified');
      }
      setStatus(await flokiAdapter.getSelfImprovementStatus());
      setError('');
    } catch (abortError) {
      setError(abortError?.message || String(abortError));
    } finally {
      setAborting(false);
    }
  }, []);

  const trainingAbortAvailable = Boolean(
    status &&
    (status.active_run_kind || status.active_kind) === 'training' &&
    !['aborted', 'completed', 'inactive'].includes(String(status.observed_state || ''))
  );

  return (
    <section className="flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-black/70">
      <header className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div>
          <p className="text-xs font-bold text-foreground">RSI Terminal</p>
          <p className="text-[10px] font-mono text-muted-foreground">
            {terminal.sourceKind || 'waiting for source'}
            {terminal.runId ? ` · ${terminal.runId}` : ''}
            {` · bytes ${terminal.startCursor}-${terminal.endCursor}/${terminal.fileSize}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
            onClick={loadOlder}
            disabled={!terminal.hasOlder || loadingOlder}
          >
            {loadingOlder ? 'Loading…' : 'Load older output'}
          </button>
          <button
            type="button"
            aria-pressed={following}
            className={
              following
                ? 'rounded border border-emerald-400/70 bg-emerald-500/20 px-2 py-1 text-xs text-emerald-200'
                : 'rounded border border-border px-2 py-1 text-xs text-muted-foreground'
            }
            onClick={() => xtermRef.current?.followOutput()}
          >
            {following ? 'Following output' : 'Follow output'}
          </button>
          {trainingAbortAvailable && (
            <button
              type="button"
              className="rounded border border-red-500/60 px-2 py-1 text-xs text-red-300 disabled:opacity-50"
              onClick={abortTraining}
              disabled={aborting}
            >
              {aborting ? 'Aborting…' : 'Abort Training'}
            </button>
          )}
        </div>
      </header>
      {error && (
        <p className="flex-none border-b border-red-500/30 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
      {/* Fixed, clamped terminal body: log length can never change the card
          height, and all terminal scrolling happens inside xterm's own
          viewport. The xterm host fills this box absolutely. */}
      <div className="relative flex-none min-w-0 overflow-hidden h-[clamp(280px,34vh,430px)] min-h-[260px] max-h-[430px]">
        <ReadOnlyXtermTerminal
          ref={xtermRef}
          revision={terminal.revision}
          revisionKind={terminal.revisionKind}
          chunks={terminal.chunks}
          hasSource={Boolean(terminal.sourceId)}
          scrollbackLines={status?.ui_limits?.terminal_event_limit}
          atBottomThresholdPx={status?.ui_limits?.terminal_at_bottom_threshold_px}
          onFollowingChange={setFollowing}
        />
      </div>
    </section>
  );
}

export default function RSILab({ flokiStatus }) {
  return (
    // Page root: own the full viewport height and become the layout frame, NOT
    // the scroll container. min-h-0 + overflow-hidden keep the document/page
    // from ever growing a vertical scrollbar; children scroll internally.
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {/* Title bar — fixed, never scrolls */}
      <div className="flex-none px-6 pt-5 pb-3 flex items-center gap-3">
        <FlaskConical className="w-5 h-5 text-neon-cyan" />
        <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">RSI Lab</h2>
      </div>

      {/* Controls + objective card + candidate review workspace. Bounded flex
          region (flex-[3]); min-h-0 lets it shrink so it can never push the
          terminal off-screen, and overflow-y-auto scrolls its contents
          INTERNALLY (the panel's own left list / right detail / objective +
          actions stay usable without any page-level scroll). */}
      <div className="flex-[3] min-h-0 overflow-hidden min-w-0 px-6">
        <SelfImprovementPanel />
      </div>

      {/* RSI terminal — anchored at the bottom. The card owns a fixed,
          clamped height (see RSITerminal), so terminal content can never
          expand the page vertically or horizontally; xterm scrolls
          internally and FitAddon fits the cell grid to the box. */}
      <div className="flex-none min-w-0 overflow-hidden px-6 pb-5 pt-3">
        <RSITerminal />
      </div>
    </div>
  )
}
