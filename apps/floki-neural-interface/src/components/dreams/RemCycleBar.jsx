import React from 'react';
import { cn } from '@/lib/utils';

function formatDurationShort(ms) {
  const mins = Math.round(ms / 60000);
  return `${mins}m`;
}

export default function RemCycleBar({ cycle, width, index }) {
  const intensityPercent = Math.round(cycle.intensity * 100);

  return (
    <div
      className={cn(
        'relative h-10 rounded-md transition-all group',
        'border border-neon-cyan/20',
      )}
      style={{
        width: `${Math.max(width, 4)}%`,
        background: `linear-gradient(90deg, 
          hsl(222 47% 8% / 0.9) 0%, 
          hsl(185 100% 50% / 0.08) 40%, 
          hsl(185 100% 50% / ${0.04 + cycle.intensity * 0.08}) 100%)`
      }}
    >
      {/* Cycle label */}
      <div className="absolute inset-0 flex items-center px-2">
        <span className="text-[10px] font-mono text-neon-cyan/80 font-semibold">
          REM {cycle.cycleNumber}
        </span>
      </div>

      {/* Hover tooltip */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-md bg-card border border-border shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20 min-w-[160px]">
        <div className="text-[10px] font-mono space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Duration</span>
            <span className="text-neon-cyan">{formatDurationShort(cycle.duration)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Intensity</span>
            <span className="text-neon-cyan">{intensityPercent}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Fragments</span>
            <span className="text-neon-cyan">{cycle.fragmentCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Lucid</span>
            <span className="text-neon-amber">{cycle.lucidMoments}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Emotion</span>
            <span className="text-neon-blue">{cycle.dominantEmotion}</span>
          </div>
        </div>
      </div>

      {/* Intensity indicator dots */}
      <div className="absolute -bottom-1.5 left-0 right-0 flex justify-center gap-0.5">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className={cn(
              'w-1 h-1 rounded-full transition-colors',
              i < Math.ceil(cycle.intensity * 5)
                ? 'bg-neon-cyan/60'
                : 'bg-neon-cyan/10'
            )}
          />
        ))}
      </div>
    </div>
  );
}