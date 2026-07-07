import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Brain, Eye, Headphones, Moon, Play, RotateCw, Sparkles, Square, Volume2, Zap } from 'lucide-react';
import flokiAdapter from '@/integrations/floki/adapter';
import { cn } from '@/lib/utils';

const MODULE_ORDER = [
  'cognition',
  'hearing',
  'vision',
  'speech',
  'memory',
  'sleep_scheduler',
  'dream_engine',
  'rsi',
  'authoritative_api',
  'live_event_stream'
];

const ICONS = {
  cognition: Brain,
  hearing: Headphones,
  vision: Eye,
  speech: Volume2,
  memory: Sparkles,
  sleep_scheduler: Moon,
  dream_engine: Moon,
  rsi: Zap,
  authoritative_api: Brain,
  live_event_stream: Sparkles
};

function normalizeStatus(value) {
  const text = String(value || 'stopped').toLowerCase();
  if (text === 'running') return 'running';
  if (text === 'degraded') return 'degraded';
  return 'stopped';
}

function statusLabel(value) {
  const status = normalizeStatus(value);
  if (status === 'running') return 'ONLINE';
  if (status === 'degraded') return 'DEGRADED';
  return 'OFFLINE';
}

function statusClasses(value) {
  const status = normalizeStatus(value);
  if (status === 'running') return {
    dot: 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]',
    text: 'text-emerald-300',
    border: 'border-emerald-400/25',
    bg: 'bg-emerald-400/8'
  };
  if (status === 'degraded') return {
    dot: 'bg-amber-300 shadow-[0_0_12px_rgba(252,211,77,0.8)]',
    text: 'text-amber-300',
    border: 'border-amber-300/30',
    bg: 'bg-amber-300/8'
  };
  return {
    dot: 'bg-red-400 shadow-[0_0_12px_rgba(248,113,113,0.8)]',
    text: 'text-red-300',
    border: 'border-red-400/30',
    bg: 'bg-red-400/8'
  };
}

function formatAge(timestamp) {
  const ms = Number(timestamp || 0);
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  const age = Math.max(0, Date.now() - ms);
  if (age < 1000) return 'now';
  if (age < 60000) return `${Math.floor(age / 1000)}s`;
  return `${Math.floor(age / 60000)}m`;
}

function moduleSummary(service) {
  const parts = [];
  if (service?.lastHeartbeat) parts.push(`hb ${formatAge(service.lastHeartbeat)}`);
  if (service?.connectedClientCount != null) parts.push(`clients ${service.healthyClientCount || 0}/${service.connectedClientCount || 0}`);
  if (service?.transportType) parts.push(String(service.transportType));
  return parts.join(' · ') || 'status linked';
}

function PresencePill({ label, active, warning }) {
  return (
    <div className={cn(
      'rounded-md border px-2 py-1 text-[10px] font-mono tracking-wide',
      active ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' :
        warning ? 'border-amber-400/30 bg-amber-400/10 text-amber-200' :
          'border-red-400/30 bg-red-400/10 text-red-200'
    )}>
      {label}
    </div>
  );
}

function ModuleCard({ service, busyKey, onAction }) {
  const Icon = ICONS[service.key] || Sparkles;
  const styles = statusClasses(service.status);
  const disabled = Boolean(busyKey);
  const actionClass = 'inline-flex items-center justify-center gap-1 rounded border border-slate-600/60 bg-slate-900/70 px-2 py-1 text-[10px] font-mono text-slate-100 hover:bg-slate-800 disabled:opacity-45 disabled:cursor-not-allowed';
  return (
    <section
      className={cn('rounded-lg border p-3', styles.border, styles.bg)}
      data-testid={`desktop-widget-module-${service.key}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn('h-4 w-4 flex-none', styles.text)} />
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-slate-100">{service.name}</div>
            <div className={cn('mt-0.5 flex items-center gap-1 text-[10px] font-mono', styles.text)}>
              <span className={cn('h-2 w-2 rounded-full', styles.dot)} />
              {statusLabel(service.status)}
            </div>
          </div>
        </div>
        <div className="text-[9px] font-mono text-slate-500">{String(service.lifecycleState || '').toUpperCase()}</div>
      </div>

      <div className="mt-2 space-y-1 text-[10px] font-mono text-slate-300">
        <div>{moduleSummary(service)}</div>
        {service.detail && <div className="line-clamp-2 text-slate-400">{service.detail}</div>}
        {service.dependencyWarning && <div className="text-amber-300">Needs: {service.dependencyWarning}</div>}
        {service.lastError && <div className="line-clamp-2 text-red-300">Error: {service.lastError}</div>}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1.5" data-testid={`desktop-widget-actions-${service.key}`}>
        {service.startAvailable && (
          <button type="button" disabled={disabled} onClick={() => onAction(service, 'start')} className={actionClass}>
            <Play className="h-3 w-3" /> Start
          </button>
        )}
        {service.stopAvailable && (
          <button type="button" disabled={disabled} onClick={() => onAction(service, 'stop')} className={actionClass}>
            <Square className="h-3 w-3" /> Stop
          </button>
        )}
        {(service.restartAvailable || service.resetAvailable) && (
          <button type="button" disabled={disabled} onClick={() => onAction(service, 'reset')} className={actionClass}>
            <RotateCw className="h-3 w-3" /> Reset
          </button>
        )}
      </div>
    </section>
  );
}

export default function DesktopWidget() {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState(null);
  const [services, setServices] = useState([]);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextServices] = await Promise.all([
        flokiAdapter.getInitialStatus(),
        flokiAdapter.getSystemStatus()
      ]);
      setStatus(nextStatus);
      setServices(Array.isArray(nextServices) ? nextServices : []);
      setError(null);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!active) return;
      await load();
    };
    run();
    const timer = window.setInterval(run, 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    let active = true;
    if (window.flokiWidget?.getState) {
      window.flokiWidget.getState().then((state) => {
        if (active && typeof state?.expanded === 'boolean') setExpanded(state.expanded);
      }).catch(() => undefined);
    }
    return () => { active = false; };
  }, []);

  const orderedServices = useMemo(() => {
    const byKey = new Map(services.map((service) => [service.key, service]));
    return MODULE_ORDER.map((key) => byKey.get(key)).filter(Boolean);
  }, [services]);

  const runtime = status?.runtime || {};
  const hearing = runtime.hearing || {};
  const lifecycle = runtime.lifecycle || {};
  const online = status?.online === true || runtime.api_ready === true;
  const listening = runtime.hearing_ready === true || hearing.microphone_open === true || String(hearing.service_state || '').toLowerCase() === 'listening';
  const seeing = status?.visionActive === true || runtime.vision_ready === true;
  const speaking = hearing.speaking === true;
  const awake = lifecycle.is_awake !== false;
  const dreaming = lifecycle.is_dreaming === true || lifecycle.is_rem_dreaming === true;

  const toggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    try {
      if (next) await window.flokiWidget?.expand?.();
      else await window.flokiWidget?.collapse?.();
    } catch (_error) {
      // Keep the React state responsive even if the window manager denies a move.
    }
  }, [expanded]);

  const onAction = useCallback(async (service, action) => {
    if (!service?.key || busyKey) return;
    const key = `${service.key}:${action}`;
    setBusyKey(key);
    try {
      await flokiAdapter.controlModule(service.key, action);
      await load();
    } catch (err) {
      setError(`${service.name} ${action} failed: ${err?.message || err}`);
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, load]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={toggle}
        data-testid="floki-desktop-widget-tab"
        className="flex h-screen w-full flex-col items-center justify-center gap-3 bg-slate-950 text-slate-100"
        title="Open Floki status widget"
      >
        <span className={cn('h-3 w-3 rounded-full', online ? 'bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.95)]' : 'bg-red-400 shadow-[0_0_14px_rgba(248,113,113,0.95)]')} />
        <span className="rotate-90 whitespace-nowrap text-[11px] font-black tracking-[0.35em] text-cyan-200">FLOKI</span>
      </button>
    );
  }

  return (
    <div data-testid="floki-desktop-side-widget" className="h-screen overflow-hidden bg-slate-950 text-slate-100">
      <div className="flex h-full flex-col border-l border-cyan-400/30 shadow-[-12px_0_45px_rgba(8,145,178,0.25)]">
        <header className="border-b border-cyan-400/20 bg-slate-900/90 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-black uppercase tracking-[0.28em] text-cyan-200">Floki Runtime</div>
              <div className="mt-1 text-[10px] font-mono text-slate-400">desktop side widget · chat.local authority</div>
            </div>
            <button
              type="button"
              onClick={toggle}
              className="rounded border border-cyan-400/30 px-2 py-1 text-[10px] font-mono text-cyan-100 hover:bg-cyan-400/10"
            >
              Hide
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <PresencePill label={online ? 'ONLINE' : 'OFFLINE'} active={online} />
            <PresencePill label={awake ? (dreaming ? 'DREAMING' : 'AWAKE') : 'SLEEPING'} active={awake && !dreaming} warning={dreaming} />
            <PresencePill label={listening ? 'LISTENING' : 'MIC OFF'} active={listening} />
            <PresencePill label={seeing ? 'SEEING' : 'CAMERA OFF'} active={seeing} />
            <PresencePill label={speaking ? 'SPEAKING' : 'IDLE VOICE'} active={speaking} warning={!speaking} />
            <PresencePill label={runtime.websocket_ready ? 'WS ONLINE' : 'WS OFFLINE'} active={runtime.websocket_ready === true} />
          </div>
          {error && (
            <div className="mt-3 flex gap-2 rounded border border-red-400/25 bg-red-400/10 p-2 text-[10px] font-mono text-red-200">
              <AlertTriangle className="h-3 w-3 flex-none" />
              <span className="line-clamp-3">{error}</span>
            </div>
          )}
        </header>

        <main className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {orderedServices.map((service) => (
            <ModuleCard
              key={service.key}
              service={service}
              busyKey={busyKey}
              onAction={onAction}
            />
          ))}
          {orderedServices.length === 0 && (
            <div className="rounded border border-red-400/25 bg-red-400/10 p-3 text-xs text-red-200">
              Runtime module status is unavailable.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
