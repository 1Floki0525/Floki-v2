import React, { useEffect, useState } from 'react';
import NeonPanel from '@/components/shared/NeonPanel';
import flokiAdapter from '@/integrations/floki/adapter';
import { cn } from '@/lib/utils';

function ago(ms) {
  if (ms == null) return 'unknown';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

export default function ObservationCard() {
  const [obs, setObs] = useState(null);
  const [meta, setMeta] = useState({ fresh: false, stale: false, age: null, source: null, ts: null });
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [next, frame] = await Promise.all([
          flokiAdapter.getObservation(),
          flokiAdapter.getVisionFrame(),
        ]);
        if (!active) return;
        const frameLive = frame?.connectionStatus === 'active' && frame?.frame?.fresh === true;
        const observationFresh = frameLive && next?.fresh === true && next?.stale !== true;
        setObs(observationFresh ? next : null);
        setMeta({
          fresh: observationFresh,
          stale: frameLive ? next?.stale === true : true,
          age: next?.observation_age_ms ?? frame?.frame?.ageMs ?? null,
          source: observationFresh ? (next?.source || frame?.service?.camera_device || null) : null,
          ts: observationFresh ? (next?.latest_private_observation_timestamp || next?.created_at || null) : null,
        });
      } catch (error) {
        console.error(error);
        if (!active) return;
        setObs(null);
        setMeta({ fresh: false, stale: false, age: null, source: null, ts: null });
      }
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const text = obs?.observation_summary || obs?.description || obs?.summary || obs?.scene || 'No current visual observation is available.';
  const isLive = meta.fresh && !meta.stale;

  return (
    <NeonPanel title="Latest Observation" badge={isLive ? 'LIVE' : meta.stale ? 'STALE' : 'OFFLINE'}>
      <p className="text-xs leading-relaxed text-foreground/80">{text}</p>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[9px] font-mono">
        <span className="text-muted-foreground">Status</span>
        <span className={cn(isLive ? 'text-emerald-400' : meta.stale ? 'text-neon-amber' : 'text-muted-foreground/50')}>
          {isLive ? 'Live' : meta.stale ? 'Stale' : 'Unavailable'}
        </span>
        <span className="text-muted-foreground">Age</span>
        <span className="text-foreground/70">{meta.age != null ? ago(meta.age) : '—'}</span>
        <span className="text-muted-foreground">Source</span>
        <span className="text-foreground/70 truncate">{meta.source || 'webcam'}</span>
        <span className="text-muted-foreground">Timestamp</span>
        <span className="text-foreground/70">{meta.ts ? new Date(meta.ts).toLocaleTimeString() : '—'}</span>
      </div>
    </NeonPanel>
  );
}
