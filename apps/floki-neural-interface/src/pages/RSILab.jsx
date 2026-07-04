import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, FlaskConical, Terminal, AlertTriangle } from 'lucide-react'
import SelfImprovementPanel from '@/components/system/SelfImprovementPanel'
import flokiAdapter from '@/integrations/floki/adapter'

// Seed values used only until the first status response delivers the
// YAML-authoritative ui_limits (rsi_terminal_* keys in chat.config.yaml).
const TERMINAL_BOOTSTRAP_LIMITS = Object.freeze({
  chunk_bytes: 64 * 1024,
  window_bytes: 2 * 1024 * 1024,
  poll_ms: 1000
})

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

// Retained terminal history is bounded by the YAML-authoritative
// ui_limits.terminal_event_limit (lines) on top of the byte window.
function capLinesStart(result, maxLines) {
  const limit = Number(maxLines)
  if (!Number.isFinite(limit) || limit <= 0) return result
  const lines = result.text.split('\n')
  if (lines.length <= limit) return result
  const removed = lines.slice(0, lines.length - limit).join('\n') + '\n'
  return {
    text: lines.slice(lines.length - limit).join('\n'),
    removedBytes: result.removedBytes + new TextEncoder().encode(removed).length
  }
}

function capLinesEnd(result, maxLines) {
  const limit = Number(maxLines)
  if (!Number.isFinite(limit) || limit <= 0) return result
  const lines = result.text.split('\n')
  if (lines.length <= limit) return result
  const removed = '\n' + lines.slice(limit).join('\n')
  return {
    text: lines.slice(0, limit).join('\n'),
    removedBytes: result.removedBytes + new TextEncoder().encode(removed).length
  }
}

function trimUtf8Start(text, maxBytes) {
  const bytes = new TextEncoder().encode(String(text || ''))
  if (bytes.length <= maxBytes) return { text: String(text || ''), removedBytes: 0 }
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  return {
    text: new TextDecoder().decode(bytes.subarray(start)),
    removedBytes: start
  }
}

function trimUtf8End(text, maxBytes) {
  const bytes = new TextEncoder().encode(String(text || ''))
  if (bytes.length <= maxBytes) return { text: String(text || ''), removedBytes: 0 }
  let end = maxBytes
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    removedBytes: bytes.length - end
  }
}

function RSITerminal() {
  const [terminal, setTerminal] = useState({
    sourceId: null,
    sourceKind: null,
    runId: null,
    startCursor: 0,
    endCursor: 0,
    fileSize: 0,
    text: '',
    hasOlder: false,
    active: false
  });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [aborting, setAborting] = useState(false);
  const viewportRef = useRef(null);
  const terminalRef = useRef(terminal);
  const uiLimitsRef = useRef(null);

  useEffect(() => {
    terminalRef.current = terminal;
  }, [terminal]);

  const applyChunk = useCallback((payload, mode = 'append') => {
    if (!payload || payload.ok !== true) return;
    setTerminal((current) => {
      const sourceChanged = Boolean(
        current.sourceId && payload.source_id &&
        current.sourceId !== payload.source_id
      );
      const lineLimit = uiLimitsRef.current?.terminal_event_limit;
      if (sourceChanged || !current.sourceId) {
        const initial = capLinesStart(
          trimUtf8Start(String(payload.text || ''), terminalWindowBytes(uiLimitsRef.current)),
          lineLimit
        );
        return {
          sourceId: payload.source_id || null,
          sourceKind: payload.source_kind || null,
          runId: payload.run_id || null,
          startCursor: Number(payload.cursor || 0) + initial.removedBytes,
          endCursor: Number(payload.next_cursor || 0),
          fileSize: Number(payload.file_size || 0),
          text: initial.text,
          hasOlder: payload.has_older === true || initial.removedBytes > 0,
          active: payload.active === true
        };
      }
      if (mode === 'older') {
        const combined = String(payload.text || '') + current.text;
        const trimmed = capLinesEnd(
          trimUtf8End(combined, terminalWindowBytes(uiLimitsRef.current)),
          lineLimit
        );
        return {
          ...current,
          startCursor: Number(payload.cursor || current.startCursor),
          endCursor: current.endCursor - trimmed.removedBytes,
          fileSize: Number(payload.file_size || current.fileSize),
          text: trimmed.text,
          hasOlder: payload.has_older === true,
          active: payload.active === true
        };
      }
      if (Number(payload.cursor) !== current.endCursor) {
        return current;
      }
      const combined = current.text + String(payload.text || '');
      const trimmed = capLinesStart(
        trimUtf8Start(combined, terminalWindowBytes(uiLimitsRef.current)),
        lineLimit
      );
      return {
        ...current,
        sourceKind: payload.source_kind || current.sourceKind,
        runId: payload.run_id || current.runId,
        startCursor: current.startCursor + trimmed.removedBytes,
        endCursor: Number(payload.next_cursor || current.endCursor),
        fileSize: Number(payload.file_size || current.fileSize),
        text: trimmed.text,
        hasOlder: current.hasOlder || trimmed.removedBytes > 0 || payload.has_older === true,
        active: payload.active === true
      };
    });
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    const poll = async () => {
      try {
        const current = terminalRef.current;
        let [payload, nextStatus] = await Promise.all([
          flokiAdapter.getSelfImprovementTerminal({
            cursor: current.endCursor,
            max_bytes: terminalChunkBytes(uiLimitsRef.current)
          }),
          flokiAdapter.getSelfImprovementStatus()
        ]);
        if (stopped) return;
        if (
          current.sourceId &&
          payload?.source_id &&
          payload.source_id !== current.sourceId
        ) {
          payload = await flokiAdapter.getSelfImprovementTerminal({
            cursor: 0,
            max_bytes: terminalChunkBytes(uiLimitsRef.current)
          });
          if (stopped) return;
        }
        applyChunk(payload, 'append');
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
    <section className="rounded-lg border border-border/60 bg-black/70 overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div>
          <p className="text-xs font-semibold text-foreground">Raw read-only RSI terminal</p>
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
        <p className="border-b border-red-500/30 px-3 py-2 text-xs text-red-300">{error}</p>
      )}
      <pre
        ref={viewportRef}
        className="h-[460px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-emerald-200"
        aria-label="Raw read-only RSI terminal output"
      >
        {terminal.text || 'No raw terminal output is available yet.'}
      </pre>
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
      <div className="flex-[3] min-h-0 overflow-hidden px-6">
        <SelfImprovementPanel />
      </div>

      {/* RSI terminal — anchored at the bottom with a stable flex ratio
          (flex-[2]) and a readable floor (min-h-[16rem]) so it survives short
          viewports like 1366x768. overflow-hidden bounds the region; the
          RSITerminal's own flex-1 body handles internal scrolling while its
          header/footer stay visible. */}
      <div className="flex-[2] min-h-[16rem] overflow-hidden px-6 pb-5 pt-3">
        <RSITerminal />
      </div>
    </div>
  )
}
