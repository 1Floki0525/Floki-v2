import React, { useCallback, useEffect, useMemo, useState } from 'react';
import flokiAdapter from '@/integrations/floki/adapter';
import DreamsHeader from '@/components/dreams/DreamsHeader';
import DreamsTimeline from '@/components/dreams/DreamsTimeline';
import DreamFragmentCard from '@/components/dreams/DreamFragmentCard';

const REFRESH_INTERVAL_MS = 3000;
const COUNTDOWN_INTERVAL_MS = 1000;

function formatCountdown(ms, includeHours = false) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (includeHours || hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function sessionLabel(session) {
  if (!session || session.active !== true) return null;
  if (session.status === 'dreaming') return 'REM DREAMING';
  if (session.status === 'failed') return 'DREAM FAILED';
  if (session.status === 'complete') return 'DREAM COMPLETE';
  return session.kind === 'manual_nap'
    ? `ASLEEP — ${Number(session.durationMinutes || 0)}-MINUTE NAP`
    : 'ASLEEP — NIGHTLY SLEEP';
}

export default function DreamsDashboard({ flokiStatus }) {
  const [timeline, setTimeline] = useState(null);
  const [rsiStatus, setRsiStatus] = useState(null);
  const [selectedDreamId, setSelectedDreamId] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [clock, setClock] = useState(Date.now());

  const refreshTimeline = useCallback(async () => {
    try {
      const [next, status] = await Promise.all([
        flokiAdapter.getDreamTimeline(),
        flokiAdapter.getSelfImprovementStatus()
      ]);
      setTimeline(next);
      setRsiStatus(status);
      setSelectedDreamId((current) => {
        if (current && next.dreams?.some((dream) => dream.id === current)) return current;
        return next.dreams?.[0]?.id || null;
      });
      setLoadError(null);
    } catch (error) {
      setLoadError(error.message || String(error));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (active) await refreshTimeline();
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refreshTimeline]);

  useEffect(() => {
    let unsubscribe = null;
    let cancelled = false;
    (async () => {
      try {
        if (typeof flokiAdapter.subscribeRuntimeEvents === 'function') {
          unsubscribe = await flokiAdapter.subscribeRuntimeEvents((event) => {
            if (cancelled) return;
            const type = event && event.type;
            if (
              type === 'status.update' ||
              type === 'inner-stream.entry' ||
              type === 'transcript.entry' ||
              type === 'stream.connected'
            ) {
              refreshTimeline();
            }
          });
        }
      } catch (error) {
        console.error('dreams dashboard live subscription failed', error);
      }
    })();
    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (error) { /* ignore */ }
      }
    };
  }, [refreshTimeline]);

  useEffect(() => {
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), COUNTDOWN_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    refreshTimeline();
  }, [flokiStatus?.sleepState, flokiStatus?.state, refreshTimeline]);

  const selectedDream = useMemo(() => (
    timeline?.dreams?.find((dream) => dream.id === selectedDreamId) || null
  ), [timeline, selectedDreamId]);

  const [busyAction, setBusyAction] = useState(null);
  const [actionError, setActionError] = useState(null);

  const handleAction = useCallback(async (action) => {
    setBusyAction(action);
    setActionError(null);
    try {
      const result = await flokiAdapter.control(action);
      if (result && result.ok === false && result.verified === false) {
        setActionError(result.message || result.error || `${action} failed`);
      }
      await refreshTimeline();
    } catch (error) {
      setActionError(error.message || String(error));
    } finally {
      setBusyAction(null);
    }
  }, [refreshTimeline]);

  if (!timeline) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 mx-auto rounded-full border-2 border-neon-cyan/30 border-t-neon-cyan animate-spin" />
          <p className="text-xs text-muted-foreground font-mono">
            {loadError ? `DREAM DATA ERROR: ${loadError}` : 'LOADING DREAM DATA...'}
          </p>
        </div>
      </div>
    );
  }

  const activeSession = timeline.activeSession;
  const activeLabel = sessionLabel(activeSession);
  const nightlyCycle = rsiStatus?.nightly_cycle || null;
  const isNightly = activeSession?.kind === 'nightly_sleep';
  const sleepRemainingMs = activeSession?.wakeAt
    ? Math.max(0, new Date(activeSession.wakeAt).getTime() - clock)
    : Math.max(0, Number(activeSession?.remainingMs || 0));
  const nextRemCountdownMs = activeSession?.nextRemCycleAt
    ? Math.max(0, new Date(activeSession.nextRemCycleAt).getTime() - clock)
    : null;
  const completedCycles = Number.isFinite(Number(activeSession?.completedRemCycles))
    ? Number(activeSession.completedRemCycles)
    : Array.isArray(timeline.cycles)
      ? timeline.cycles.filter((cycle) => cycle.status === 'complete').length
      : 0;
  const totalCycles = Number.isFinite(Number(activeSession?.totalRemCycles))
    ? Number(activeSession.totalRemCycles)
    : Array.isArray(timeline.cycles)
      ? timeline.cycles.length
      : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <DreamsHeader timeline={timeline} onRefresh={refreshTimeline} />

        {activeLabel && (
          <div className="glass-panel rounded-lg border border-neon-cyan/30 px-4 py-3">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-semibold tracking-[0.18em] text-neon-cyan font-mono">
                  {activeLabel}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground font-mono">
                  {isNightly
                    ? 'One complete HF training epoch, then one REM dream, repeating until 07:00 America/Toronto. One adapter candidate is compiled for review at wake.'
                    : activeSession.status === 'dreaming'
                      ? `REM cycle ${activeSession.currentRemCycle || '—'} is generating a full first-person dream now.`
                      : 'Manual 30-minute nap: REM at +10 and +20 minutes, wake at +30 minutes.'}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground/70 font-mono">
                  {isNightly
                    ? `Completed epochs: ${Number(nightlyCycle?.completed_epochs || 0)} · Completed dreams: ${Number(nightlyCycle?.completed_rem_cycles || 0)} · Next: ${nightlyCycle?.next_action || 'training epoch'}`
                    : `REM cycles: ${completedCycles}/${totalCycles} complete`}
                </p>
                {activeSession.lastError && (
                  <p className="mt-1 text-[11px] text-red-400 font-mono">{activeSession.lastError}</p>
                )}
                {isNightly && nightlyCycle?.error && (
                  <p className="mt-1 text-[11px] text-red-400 font-mono">{nightlyCycle.error}</p>
                )}
                {actionError && (
                  <p className="mt-1 text-[11px] text-red-400 font-mono">Dreams action failed: {actionError}</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleAction('wake')}
                    disabled={busyAction !== null}
                    data-testid="dreams-wake-control"
                    aria-busy={busyAction === 'wake'}
                    className="text-[10px] font-mono px-3 py-1.5 rounded border border-neon-amber/40 bg-neon-amber/10 text-neon-amber hover:bg-neon-amber/20 disabled:opacity-40 disabled:cursor-wait"
                  >
                    {busyAction === 'wake' ? 'Waking…' : 'Wake Floki'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAction('requestSleep')}
                    disabled={busyAction !== null}
                    data-testid="dreams-request-sleep-control"
                    aria-busy={busyAction === 'requestSleep'}
                    className="text-[10px] font-mono px-3 py-1.5 rounded border border-neon-blue/40 bg-neon-blue/10 text-neon-blue hover:bg-neon-blue/20 disabled:opacity-40 disabled:cursor-wait"
                  >
                    {busyAction === 'requestSleep' ? 'Requesting…' : 'Request Sleep'}
                  </button>
                </div>
              </div>

              {isNightly ? (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 min-w-[360px] font-mono">
                <div className="rounded-md border border-border/50 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Wake countdown</p>
                  <p className="text-lg font-semibold text-foreground">
                    {formatCountdown(sleepRemainingMs, true)}
                  </p>
                </div>
                <div className="rounded-md border border-neon-cyan/20 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Current epoch</p>
                  <p className="text-lg font-semibold text-neon-cyan">
                    {nightlyCycle?.current_epoch || '—'}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {String(nightlyCycle?.epoch_state || 'waiting').replaceAll('_', ' ')}
                  </p>
                </div>
                <div className="rounded-md border border-neon-cyan/20 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Current REM</p>
                  <p className="text-lg font-semibold text-neon-cyan">
                    {nightlyCycle?.current_rem_cycle ? `Cycle ${nightlyCycle.current_rem_cycle}` : '—'}
                  </p>
                </div>
                <div className="rounded-md border border-border/50 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Epochs complete</p>
                  <p className="text-lg font-semibold text-foreground">
                    {Number(nightlyCycle?.completed_epochs || 0)}
                  </p>
                </div>
                <div className="rounded-md border border-border/50 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Dreams complete</p>
                  <p className="text-lg font-semibold text-foreground">
                    {Number(nightlyCycle?.completed_rem_cycles || 0)}
                  </p>
                </div>
                <div className="rounded-md border border-border/50 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Next action</p>
                  <p className="text-sm font-semibold text-foreground">
                    {nightlyCycle?.next_action || 'training epoch'}
                  </p>
                  <p className="text-[10px] text-muted-foreground">One candidate per night</p>
                </div>
              </div>
              ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-[300px] font-mono">
                <div className="rounded-md border border-border/50 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Sleep remaining</p>
                  <p className="text-lg font-semibold text-foreground">
                    {formatCountdown(sleepRemainingMs, false)}
                  </p>
                </div>
                <div className="rounded-md border border-neon-cyan/20 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {activeSession.status === 'dreaming' ? 'Current REM' : 'Next REM in'}
                  </p>
                  <p className="text-lg font-semibold text-neon-cyan">
                    {activeSession.status === 'dreaming'
                      ? `Cycle ${activeSession.currentRemCycle || '—'}`
                      : nextRemCountdownMs === null
                        ? '—'
                        : formatCountdown(nextRemCountdownMs)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Manual nap REM remains +10 / +20, wake +30.
                  </p>
                </div>
              </div>
              )}
            </div>
          </div>
        )}

        {loadError && (
          <div className="glass-panel rounded-lg border border-red-500/30 px-4 py-3 text-[11px] text-red-400 font-mono">
            Live refresh failed: {loadError}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
          <div className="xl:col-span-2">
            <DreamsTimeline
              timeline={timeline}
              selectedDreamId={selectedDreamId}
              onSelectDream={(dream) => setSelectedDreamId(dream.id)}
            />
          </div>
          <div className="xl:col-span-3">
            {selectedDream ? (
              <DreamFragmentCard dream={selectedDream} />
            ) : (
              <div className="glass-panel rounded-lg p-8 text-center border border-border/50 flex flex-col items-center justify-center min-h-[360px]">
                <div className="w-14 h-14 mb-4 rounded-full bg-neon-cyan/5 border border-neon-cyan/10 flex items-center justify-center">
                  <svg className="w-6 h-6 text-neon-cyan/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                </div>
                <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">
                  {activeSession?.status === 'dreaming'
                    ? 'Dream narrative forming'
                    : 'No completed dream selected'}
                </p>
                <p className="text-[11px] text-muted-foreground/50 max-w-[320px] leading-relaxed">
                  {activeSession?.status === 'dreaming'
                    ? 'The completed title and full transcript will appear automatically when the REM dream is indexed.'
                    : 'Completed dreams appear by title in the Dream Archive on the left.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
