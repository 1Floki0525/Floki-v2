import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, FlaskConical, Terminal, AlertTriangle } from 'lucide-react'
import SelfImprovementPanel from '@/components/system/SelfImprovementPanel'
import flokiAdapter from '@/integrations/floki/adapter'
import { formatTorontoTime } from '@/lib/time'

const SENSITIVE_PATTERN = /(?:api[_-]?key|token|secret|password|auth[_-]?header|authorization|cookie|credential)["\s:=]+["']?[A-Za-z0-9+/=_\-]{8,}/gi;

function redactSensitive(text) {
  return String(text || '').replace(SENSITIVE_PATTERN, '[REDACTED]');
}

function safeStr(v, max) {
  return String(v || '').slice(0, max);
}

// Split text into display lines, capped at maxLines, each line capped at maxLen chars
function outputLines(text, maxLines, maxLen) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const kept = lines.filter(l => l.trim() !== '' || lines.indexOf(l) < 3).slice(0, maxLines);
  const result = kept.map(l => l.slice(0, maxLen));
  if (lines.length > maxLines) result.push(`  … (${lines.length - maxLines} more lines)`);
  return result;
}

// Faithful code/diff rendering: keep every line (including blanks) so the
// terminal shows exactly what Floki wrote, like a real editor view.
function codeLines(text, maxLines, maxLen) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const kept = lines.slice(0, maxLines).map(l => l.slice(0, maxLen));
  if (lines.length > maxLines) kept.push(`  … (${lines.length - maxLines} more lines)`);
  return kept;
}

// Expand one API event item into one or more display items
function expandToDisplayItems(item, limits) {
  const safe = (value, max = limits.terminal_safe_string_max_chars) => safeStr(value, max);
  const { source, index, record } = item;
  const type = String(record?.type || '');
  const de = record?.detail || {};
  const ts = record?.created_at || null;
  const baseId = `${source}-${index}`;

  function main(text, color) {
    return [{ id: baseId, source, ts, text: redactSensitive(text), color, isOutput: false }];
  }
  function withOutput(headerText, headerColor, lines, lineColor) {
    const items = [{ id: baseId, source, ts, text: redactSensitive(headerText), color: headerColor, isOutput: false }];
    lines.forEach((l, i) => {
      items.push({ id: `${baseId}-out-${i}`, source: null, ts: null, text: redactSensitive(l), color: lineColor, isOutput: true });
    });
    return items;
  }

  if (type === 'model_turn') {
    const thinking = Number(de.thinking_chars || 0);
    const tools = Number(de.tool_call_count || 0);
    const thinkStr = thinking > 0 ? ` | ${thinking} chars thinking` : '';
    return main(`[agent] ${tools} tool call${tools !== 1 ? 's' : ''}${thinkStr}`, 'text-violet-400');
  }

  if (type === 'shell_end') {
    const identity = safe(de.identity);
    // Show the REAL command Floki ran, not just its internal label.
    const cmd = safe(de.command, limits.terminal_command_max_chars) || identity;
    const exitCode = de.status;
    const ms = de.duration_ms != null ? ` (${de.duration_ms}ms)` : '';
    const isFocused = identity === 'focused_test';
    const prefix = isFocused ? '[test]' : '[shell]';
    const tag = identity && identity !== cmd ? ` ${identity}:` : '';
    const ok = exitCode === 0;
    const headerColor = ok ? 'text-foreground/80' : 'text-orange-300';
    const header = `${prefix}${tag} $ ${cmd} → exit ${exitCode}${ms}`;

    if (ok) {
      const stdout = safe(de.stdout, limits.terminal_output_max_chars);
      const lines = outputLines(stdout, limits.terminal_success_output_max_lines, limits.terminal_output_max_line_chars);
      if (lines.length === 0) return main(header, headerColor);
      return withOutput(header, headerColor, lines, 'text-foreground/50');
    } else {
      // On failure: stderr takes priority, fallback to stdout
      const errText = safe(de.stderr, limits.terminal_output_max_chars) || safe(de.stdout, limits.terminal_output_max_chars);
      const lines = outputLines(errText, limits.terminal_failure_output_max_lines, limits.terminal_output_max_line_chars);
      if (lines.length === 0) return main(header, headerColor);
      return withOutput(header, headerColor, lines, 'text-orange-200/70');
    }
  }

  if (type === 'shell_progress') {
    const identity = safe(de.identity);
    const cmd = safe(de.command, limits.terminal_command_max_chars) || identity;
    const tag = identity && identity !== cmd ? ` ${identity}:` : '';
    const elapsed = de.elapsed_ms != null ? ` (${Math.round(de.elapsed_ms / 1000)}s)` : '';
    return main(`[shell]${tag} $ ${cmd}${elapsed} …`, 'text-foreground/50');
  }

  if (type === 'write_file') {
    const filePath = safe(de.path);
    const bytes = de.bytes != null ? ` (${de.bytes} bytes)` : '';
    const lc = de.line_count != null ? `, ${de.line_count} lines` : '';
    const changed = de.workspace_changed ? '' : ' [noop]';
    const header = `[write] ${filePath}${bytes ? bytes.replace(')', lc + ')') : ''}${changed}`;
    // Bounded preview field (content_preview); fall back to legacy `content`.
    const preview = de.content_preview != null ? de.content_preview : de.content;
    const lines = codeLines(preview, limits.terminal_code_max_lines, limits.terminal_code_max_line_chars);
    if (de.content_truncated) lines.push('  … (content truncated — preview only)');
    if (lines.length === 0) return main(header, 'text-sky-400/80');
    return withOutput(header, 'text-sky-400/80', lines, 'text-sky-200/50');
  }

  if (type === 'apply_patch') {
    const filePath = safe(
      de.path || de.file || (Array.isArray(de.paths) ? de.paths.join(', ') : '')
    );
    const header = `[patch] ${filePath}`;
    // Bounded diff preview (patch_preview); fall back to legacy `patch`.
    const patchText = safe(de.patch_preview != null ? de.patch_preview : de.patch, limits.terminal_diff_max_chars);
    const raw = codeLines(patchText, limits.terminal_code_max_lines, limits.terminal_code_max_line_chars);
    if (de.patch_truncated) raw.push('  … (diff truncated — preview only)');
    if (raw.length === 0) return main(header, 'text-sky-400/80');
    const items = [{ id: baseId, source, ts, text: redactSensitive(header), color: 'text-sky-400/80', isOutput: false }];
    raw.forEach((l, i) => {
      let color = 'text-foreground/45';
      if (l.startsWith('+') && !l.startsWith('+++')) color = 'text-emerald-300/70';
      else if (l.startsWith('-') && !l.startsWith('---')) color = 'text-red-300/70';
      else if (l.startsWith('@@')) color = 'text-neon-cyan/60';
      items.push({ id: `${baseId}-p-${i}`, source: null, ts: null, text: redactSensitive(l), color, isOutput: true });
    });
    return items;
  }

  if (type === 'write_memory') {
    const stream = safe(de.stream || 'episodic');
    const summary = safe(de.summary, 120);
    return main(`[memory:${stream}] ${summary}`, 'text-indigo-300/80');
  }

  if (type === 'convergence_state') {
    const s = de;
    const obj = s?.selected_experiment?.objective
      ? ` — "${String(s.selected_experiment.objective).slice(0, limits.terminal_summary_max_chars)}"`
      : '';
    return main(
      `[state] ${s?.phase || '?'} iter=${s?.iteration || '?'} writes=${s?.write_count || 0} verif=${s?.verification_runs || 0}${obj}`,
      'text-muted-foreground/50'
    );
  }

  if (type === 'convergence_phase') {
    return main(`[phase→] ${de.phase || ''} (${de.reason || ''})`, 'text-neon-cyan/60');
  }

  if (type === 'convergence_block') {
    const tool = de.tool || '';
    const need = (de.allowed_next_tools || []).join(', ');
    return main(`[BLOCKED] ${tool} — next: ${need}`, 'text-orange-400');
  }

  if (type === 'convergence_advisory') {
    return main(`[advisory] ${de.reason || ''}`, 'text-muted-foreground/50');
  }

  if (type === 'select_experiment_rejected') {
    const errText = safe(de.error, limits.terminal_selection_error_max_chars);
    const lines = errText.split('\n').filter(Boolean).slice(0, limits.terminal_selection_error_max_lines).map(l => l.slice(0, limits.terminal_selection_error_line_max_chars));
    const header = `[select REJECTED] ${(lines[0] || '').slice(0, limits.terminal_summary_max_chars)}`;
    const rest = lines.slice(1);
    if (rest.length === 0) return main(header, 'text-orange-400');
    return withOutput(header, 'text-orange-400', rest, 'text-orange-300/60');
  }

  if (type === 'experiment_selected') {
    const obj = safe(de.experiment?.objective, limits.terminal_summary_max_chars);
    const focusedTest = safe(de.experiment?.focused_test, limits.terminal_summary_max_chars);
    const lines = focusedTest ? [`focused_test: ${focusedTest}`] : [];
    return withOutput(`[SELECTED] ${obj}`, 'text-emerald-400', lines, 'text-emerald-300/60');
  }

  if (type === 'implementation_started') {
    return main(`[impl] ${safe(de.experiment?.objective, limits.terminal_summary_max_chars)}`, 'text-emerald-300/80');
  }

  if (type === 'no_candidate') {
    return main(`[no candidate] ${de.reason || ''}`, 'text-yellow-400');
  }

  if (type === 'candidate_finalized' || type === 'candidate_auto_finalized_after_verification') {
    return main(`[CANDIDATE READY] ${safe(de.objective, limits.terminal_summary_max_chars)}`, 'text-emerald-300 font-bold');
  }

  if (type === 'sandbox_started') {
    return main(`[sandbox] started — ${de.run_id || ''}`, 'text-neon-cyan');
  }

  if (type === 'cycle_no_candidate') {
    return main(`[cycle end] no candidate — ${de.reason || ''}`, 'text-yellow-400');
  }

  if (type === 'cycle_failed') {
    const errText = safe(de.error, limits.terminal_selection_error_max_chars);
    const lines = outputLines(errText, limits.terminal_selection_error_max_lines, limits.terminal_selection_error_line_max_chars);
    const header = `[cycle FAILED] ${(lines[0] || de.reason || '').slice(0, limits.terminal_summary_max_chars)}`;
    return withOutput(header, 'text-red-400', lines.slice(1), 'text-red-300/60');
  }

  if (type === 'cycle_preempted') {
    return main(`[preempted] ${de.reason || ''}`, 'text-muted-foreground/60');
  }

  if (type === 'fatal') {
    return main(`[FATAL] ${safe(de.error, limits.terminal_summary_max_chars)}`, 'text-red-400 font-bold');
  }

  if (type === 'sandbox_output') {
    return main(safe(de.text, limits.terminal_output_max_chars), 'text-foreground/60');
  }

  if (type === 'parse_error') {
    return main(`[parse error] ${safe(record.raw, limits.terminal_summary_max_chars)}`, 'text-red-400/60');
  }

  if (type === 'selection_anchor_reminder') {
    return main(`[reminder] select_experiment — iter ${de.iteration || '?'}`, 'text-muted-foreground/40');
  }

  if (type === 'context_compacted') {
    return main(
      `[compact] ${de.before_chars || '?'} → ${de.after_chars || '?'} chars (kept ${de.retained_messages || '?'} msgs)`,
      'text-muted-foreground/40'
    );
  }

  if (type === 'git') {
    const args = Array.isArray(de.args) ? de.args.join(' ') : safe(de.args);
    const status = de.status != null ? ` → ${de.status}` : '';
    if (!args) return main(`[git]`, 'text-muted-foreground/30');
    return main(`[git] git ${args.slice(0, limits.terminal_summary_max_chars)}${status}`, 'text-muted-foreground/40');
  }

  if (type === 'candidate_imported') {
    return main(`[imported] candidate ${de.candidate_id || ''}`, 'text-emerald-400');
  }

  if (type === 'candidate_denied_by_maker') {
    return main(`[DENIED] ${safe(de.reason, limits.terminal_summary_max_chars)}`, 'text-red-400');
  }

  if (type === 'candidate_approved_by_maker') {
    return main(`[APPROVED] ${de.candidate_id || ''}`, 'text-emerald-400 font-bold');
  }

  if (type === 'worker_started') return main('[worker] started', 'text-neon-cyan/60');
  if (type === 'worker_cycle_start') return main('[worker] cycle starting', 'text-neon-cyan/60');

  // Skip extremely noisy low-value events entirely
  if (['finalize_git_add', 'sandbox_heartbeat', 'worker_heartbeat'].includes(type)) return [];

  return main(type.replaceAll('_', ' '), 'text-foreground/40');
}

function RSITerminal() {
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const [phase, setPhase] = useState(null)
  const [runId, setRunId] = useState(null)
  const [atBottom, setAtBottom] = useState(true)
  const [pendingCount, setPendingCount] = useState(0)

  const auditCursorRef = useRef(null)
  const sandboxCursorRef = useRef(0)
  const sandboxLogFileRef = useRef(null)
  const runIdRef = useRef(null)
  const atBottomRef = useRef(true)
  const pendingEventsRef = useRef([])
  const containerRef = useRef(null)
  const activeRef = useRef(false)
  const uiLimitsRef = useRef(null)

  atBottomRef.current = atBottom;

  const flushPending = useCallback(() => {
    if (pendingEventsRef.current.length > 0) {
      setEvents(prev => [...prev, ...pendingEventsRef.current].slice(-uiLimitsRef.current.terminal_event_limit));
      pendingEventsRef.current = [];
      setPendingCount(0);
    }
  }, []);

  const appendEvents = useCallback((newItems) => {
    if (newItems.length === 0) return;
    if (atBottomRef.current) {
      setEvents(prev => [...prev, ...newItems].slice(-uiLimitsRef.current.terminal_event_limit));
    } else {
      pendingEventsRef.current = [...pendingEventsRef.current, ...newItems];
      setPendingCount(pendingEventsRef.current.length);
    }
  }, []);

  const jumpToBottom = useCallback(() => {
    setAtBottom(true);
    flushPending();
    if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [flushPending]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nowAtBottom = uiLimitsRef.current ? distFromBottom < uiLimitsRef.current.terminal_at_bottom_threshold_px : true;
    if (nowAtBottom && !atBottomRef.current) { setAtBottom(true); flushPending(); }
    else if (!nowAtBottom && atBottomRef.current) { setAtBottom(false); }
  }, [flushPending]);

  // Pin to the bottom BEFORE the browser paints so backfilled/streamed lines
  // never flash at the top and then jump — the view stays a smooth live tail.
  useLayoutEffect(() => {
    if (atBottom && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events, atBottom]);

  useEffect(() => {
    activeRef.current = true;
    let timer = null;

    const poll = async () => {
      if (!activeRef.current) return;
      try {
        // On first load, backfill the current run from the TOP (cursor 0) so the
        // terminal reads top-down with full scrollback, exactly like a real
        // terminal session. Afterwards, tail incrementally from the saved cursor.
        if (!uiLimitsRef.current) {
          const uiStatus = await flokiAdapter.getSelfImprovementStatus();
          const configuredLimits = uiStatus?.ui_limits;
          if (!configuredLimits || !Number.isFinite(Number(configuredLimits.terminal_poll_ms))) {
            throw new Error('RSI UI limits are missing from chat YAML transport');
          }
          uiLimitsRef.current = configuredLimits;
        }
        const isInit = auditCursorRef.current === null;
        const params = isInit
          ? { audit_cursor: 0, sandbox_cursor: 0, limit: uiLimitsRef.current.terminal_initial_activity_limit }
          : { audit_cursor: auditCursorRef.current, sandbox_cursor: sandboxCursorRef.current, limit: uiLimitsRef.current.terminal_incremental_activity_limit };

        const result = await flokiAdapter.getSelfImprovementActivity(params);
        if (!activeRef.current) return;

        if (result?.ok) {
          if (result.ui_limits) uiLimitsRef.current = result.ui_limits;
          const newRunId = result.run_id || null;
          const newSandboxFile = result.sandbox_log_file || null;

          // A new sandbox run started: clear the view and backfill the new log
          // from the top on the next poll (cursor reset to 0). Skip appending
          // this round so we don't mix events read at the old offset.
          if (!isInit && newSandboxFile !== sandboxLogFileRef.current) {
            sandboxLogFileRef.current = newSandboxFile;
            sandboxCursorRef.current = 0;
            pendingEventsRef.current = [];
            setPendingCount(0);
            setEvents([]);
            setAtBottom(true);
            if (newRunId !== runIdRef.current) { runIdRef.current = newRunId; setRunId(newRunId); }
            if (result.phase) setPhase(result.phase);
            setError(null);
          } else {
            if (isInit) {
              sandboxLogFileRef.current = newSandboxFile;
              runIdRef.current = newRunId;
              setRunId(newRunId);
            } else if (newRunId !== runIdRef.current) {
              runIdRef.current = newRunId;
              setRunId(newRunId);
            }

            auditCursorRef.current = result.next_audit_cursor ?? (auditCursorRef.current ?? 0);
            sandboxCursorRef.current = result.next_sandbox_cursor ?? (sandboxCursorRef.current ?? 0);

            // Expand each API event into one or more display lines (top-down order)
            const displayItems = (result.events || []).flatMap(item => {
              try { return expandToDisplayItems(item, uiLimitsRef.current); } catch (error) { setError(error.message); return []; }
            });
            appendEvents(displayItems);

            if (result.phase) setPhase(result.phase);
            setError(null);
          }
        }
      } catch (err) {
        if (activeRef.current) setError(err.message);
      }
      if (activeRef.current && uiLimitsRef.current) timer = setTimeout(poll, uiLimitsRef.current.terminal_poll_ms);
    };

    poll();
    return () => {
      activeRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [appendEvents]);

  return (
    <div className="flex flex-col rounded-lg border border-neon-cyan/20 bg-black/40 overflow-hidden h-full" data-testid="rsi-terminal">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 bg-black/20 flex-none">
        <div className="flex items-center gap-2 min-w-0">
          <Terminal className="w-4 h-4 text-neon-cyan flex-none" />
          <span className="text-xs font-mono text-neon-cyan tracking-wide flex-none">RSI TERMINAL</span>
          {phase && <span className="text-[10px] font-mono text-muted-foreground ml-1 flex-none">{phase.replaceAll('_', ' ')}</span>}
          {runId && <span className="text-[10px] font-mono text-muted-foreground/60 ml-1 truncate">{runId}</span>}
        </div>
        {!atBottom && (
          <button
            onClick={jumpToBottom}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono border transition-colors flex-none ml-2"
            style={{
              borderColor: pendingCount > 0 ? 'rgba(0,255,255,0.3)' : 'rgba(255,255,255,0.15)',
              color: pendingCount > 0 ? 'rgb(0,255,255)' : 'inherit',
              background: pendingCount > 0 ? 'rgba(0,255,255,0.08)' : 'transparent'
            }}
          >
            <ChevronDown className="w-3 h-3" />
            {pendingCount > 0 ? `${pendingCount} new` : 'bottom'}
          </button>
        )}
      </div>

      {error && (
        <div className="px-3 py-1.5 bg-red-500/10 border-b border-red-500/20 flex items-center gap-2 text-red-400 text-xs flex-none">
          <AlertTriangle className="w-3 h-3 flex-none" />
          <span className="font-mono truncate">{error}</span>
        </div>
      )}

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-[11px] leading-snug p-3 min-h-0"
        data-testid="rsi-terminal-output"
      >
        {events.length === 0 && !error && (
          <div className="text-muted-foreground/40 italic">No activity yet — waiting for RSI sandbox...</div>
        )}
        {events.map((item) => (
          item.isOutput ? (
            <div key={item.id} className={`pl-[5.5rem] py-px whitespace-pre-wrap break-words ${item.color}`}>
              {item.text}
            </div>
          ) : (
            <div key={item.id} className={`flex gap-2 py-px ${item.color}`}>
              <span className="text-muted-foreground/25 flex-none w-[4.5rem] text-right overflow-hidden text-ellipsis whitespace-nowrap">
                {item.ts ? formatTorontoTime(item.ts) : '--:--:--'}
              </span>
              <span className="flex-none text-[9px] uppercase px-1 rounded border border-current/20 bg-current/5 leading-tight self-start mt-0.5">
                {item.source === 'controller' ? 'ctrl' : item.source === 'sandbox' ? 'sbox' : '    '}
              </span>
              <span className="break-words min-w-0 whitespace-pre-wrap">{item.text}</span>
            </div>
          )
        ))}
      </div>

      <div className="px-3 py-1 border-t border-border/30 text-[10px] font-mono text-muted-foreground/40 flex justify-between flex-none">
        <span>{events.length} lines</span>
        <span>{atBottom ? '● live' : '○ scrolled'}</span>
      </div>
    </div>
  )
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
