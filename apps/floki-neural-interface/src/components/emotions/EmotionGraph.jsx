import React, { useEffect, useMemo, useState } from 'react';
import NeonPanel from '@/components/shared/NeonPanel';
import flokiAdapter from '@/integrations/floki/adapter';
import { cn } from '@/lib/utils';

const DIMS = ['valence', 'arousal', 'trust', 'curiosity', 'hope', 'fear', 'frustration', 'attachment', 'confidence', 'uncertainty'];
const COLORS = ['#22d3ee', '#34d399', '#a78bfa', '#f472b6', '#fbbf24', '#ef4444', '#fb923c', '#38bdf8', '#4ade80', '#e879f9'];
const TIME_RANGES = [
  { key: '1min', label: '1 min', ms: 60000 },
  { key: '5min', label: '5 min', ms: 300000 },
  { key: '15min', label: '15 min', ms: 900000 },
  { key: 'session', label: 'Session', ms: Infinity },
];

function extent(values, key) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    const n = Number(v[key] ?? 0);
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  if (lo === hi) { lo = 0; hi = 1; }
  return [lo, hi];
}

export default function EmotionGraph() {
  const [history, setHistory] = useState([]);
  const [latest, setLatest] = useState({});
  const [timeRange, setTimeRange] = useState('15min');

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [emotion, past] = await Promise.all([
          flokiAdapter.getEmotion(),
          flokiAdapter.getAffectHistory(360),
        ]);
        if (!active) return;
        setLatest(emotion);
        setHistory((prev) => {
          const merged = [...past];
          const lastTs = merged.length > 0 ? merged[merged.length - 1].timestamp : 0;
          if (emotion.timestamp !== lastTs) merged.push(emotion);
          return merged.slice(-360);
        });
      } catch (error) {
        console.error(error);
      }
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const rangeMs = TIME_RANGES.find((r) => r.key === timeRange)?.ms ?? 900000;
  const now = Date.now();
  const filtered = rangeMs === Infinity
    ? history
    : (history || []).filter((h) => now - (h.timestamp || now) <= rangeMs);

  const linePaths = useMemo(() => {
    if (filtered.length < 2) return [];
    return DIMS.map((dim, di) => {
      const [lo, hi] = extent(filtered, dim);
      const range = hi - lo || 1;
      const points = filtered.map((row, i) => {
        const x = ((i) / (filtered.length - 1)) * 100;
        const y = 100 - ((Number(row[dim] ?? 0) - lo) / range) * 100;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return { dim, points, color: COLORS[di % COLORS.length] };
    });
  }, [filtered]);

  return (
    <NeonPanel title="Emotional State">
      {/* Time range selectors */}
      <div className="flex gap-1 mb-2">
        {TIME_RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setTimeRange(r.key)}
            data-testid={`emotion-range-${r.key}`}
            className={cn(
              'text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors',
              timeRange === r.key
                ? 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/40'
                : 'bg-secondary/20 text-muted-foreground/60 border-border/30 hover:border-border/60'
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* SVG graph */}
      <div className="h-32 border border-border/30 rounded bg-background/40 relative">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full">
          {[25, 50, 75].map((y) => (
            <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="currentColor" opacity="0.06" />
          ))}
          {linePaths.map((line) => (
            <polyline
              key={line.dim}
              fill="none"
              stroke={line.color}
              strokeWidth="1"
              opacity="0.7"
              points={line.points}
            />
          ))}
        </svg>
        {filtered.length < 2 && (
          <div className="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-muted-foreground/40">
            Collecting affect data...
          </div>
        )}
      </div>

      {/* Current values */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3">
        {DIMS.map((key, i) => (
          <div key={key} className="flex justify-between text-[10px] font-mono">
            <span className="capitalize text-muted-foreground" style={{ borderLeft: `2px solid ${COLORS[i % COLORS.length]}`, paddingLeft: 4 }}>{key}</span>
            <span className="text-neon-cyan">{Number(latest[key] ?? 0).toFixed(2)}</span>
          </div>
        ))}
      </div>
    </NeonPanel>
  );
}
