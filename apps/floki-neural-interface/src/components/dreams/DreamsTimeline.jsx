import React from 'react';
import { format } from 'date-fns';
import { Moon, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

function statusText(session) {
  if (!session?.active) return 'Archive';
  if (session.status === 'dreaming') return 'Dreaming now';
  if (session.status === 'pre_rem') return 'Waiting for REM';
  if (session.status === 'failed') return 'Dream failed';
  return 'Sleep active';
}

export default function DreamsTimeline({ timeline, selectedDreamId, onSelectDream }) {
  const dreams = Array.isArray(timeline.dreams) ? timeline.dreams : [];
  return (
    <div className="glass-panel rounded-lg border border-border/50 overflow-hidden">
      <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">Dream Archive</h3>
          <p className="text-[10px] text-muted-foreground font-mono mt-1">{statusText(timeline.activeSession)}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold font-mono text-foreground">{dreams.length}</p>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-mono">completed dreams</p>
        </div>
      </div>

      {timeline.cycles?.length > 0 && (
        <div className="px-5 py-3 border-b border-border/30 flex flex-wrap gap-2">
          {timeline.cycles.map((cycle) => (
            <span key={cycle.id} className={cn(
              'px-2 py-1 rounded border text-[9px] font-mono uppercase tracking-wider',
              cycle.status === 'dreaming'
                ? 'border-neon-cyan/50 text-neon-cyan animate-pulse'
                : cycle.status === 'failed'
                  ? 'border-red-500/40 text-red-400'
                  : 'border-border/50 text-muted-foreground'
            )}>
              REM {cycle.cycleNumber} · {cycle.status}
            </span>
          ))}
        </div>
      )}

      <div className="max-h-[620px] overflow-y-auto p-3 space-y-2">
        {dreams.length === 0 ? (
          <div className="min-h-[260px] flex flex-col items-center justify-center text-center px-6">
            <Moon className="w-8 h-8 text-neon-cyan/25 mb-3" />
            <p className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
              {timeline.activeSession?.status === 'dreaming' ? 'A dream is forming now' : 'No completed dreams yet'}
            </p>
            <p className="text-[10px] text-muted-foreground/50 mt-2 max-w-[260px] leading-relaxed">
              Completed dream titles will appear here. Source memories are used privately to form dreams and are not listed as dreams.
            </p>
          </div>
        ) : dreams.map((dream) => {
          const selected = dream.id === selectedDreamId;
          return (
            <button
              key={dream.id}
              type="button"
              onClick={() => onSelectDream(dream)}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-3 transition-all',
                selected
                  ? 'border-neon-cyan/60 bg-neon-cyan/10 shadow-[0_0_12px_hsl(185,100%,50%,0.12)]'
                  : 'border-border/40 bg-background/20 hover:border-neon-cyan/30 hover:bg-neon-cyan/5'
              )}
            >
              <div className="flex items-start gap-3">
                <Sparkles className={cn('w-4 h-4 mt-0.5 shrink-0', selected ? 'text-neon-cyan' : 'text-neon-cyan/40')} />
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm font-medium leading-snug', selected ? 'text-neon-cyan' : 'text-foreground')}>{dream.title}</p>
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
                    <span>REM {dream.remCycleNumber}</span>
                    <span>{format(new Date(dream.createdAt), 'MMM d · h:mm a')}</span>
                  </div>
                  {dream.emotionalTone?.label && (
                    <p className="mt-2 text-[10px] text-muted-foreground/70 truncate">{dream.emotionalTone.label}</p>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
