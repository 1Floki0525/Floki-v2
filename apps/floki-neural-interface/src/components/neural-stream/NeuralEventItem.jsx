import React from 'react';
import { cn } from '@/lib/utils';
import { NeuralModule, EventSeverity, PrivacyLevel } from '@/integrations/floki/types';

const moduleColors = {
  [NeuralModule.HEARING]: 'text-neon-green border-neon-green/20 bg-neon-green/5',
  [NeuralModule.VISION]: 'text-neon-cyan border-neon-cyan/20 bg-neon-cyan/5',
  [NeuralModule.THALAMUS]: 'text-blue-400 border-blue-400/20 bg-blue-400/5',
  [NeuralModule.TEMPORAL]: 'text-violet-400 border-violet-400/20 bg-violet-400/5',
  [NeuralModule.AMYGDALA]: 'text-rose-400 border-rose-400/20 bg-rose-400/5',
  [NeuralModule.EMOTIONS]: 'text-pink-400 border-pink-400/20 bg-pink-400/5',
  [NeuralModule.HIPPOCAMPUS]: 'text-amber-400 border-amber-400/20 bg-amber-400/5',
  [NeuralModule.MEMORY]: 'text-yellow-400 border-yellow-400/20 bg-yellow-400/5',
  [NeuralModule.PERSONALITY]: 'text-emerald-400 border-emerald-400/20 bg-emerald-400/5',
  [NeuralModule.PINEAL]: 'text-indigo-400 border-indigo-400/20 bg-indigo-400/5',
  [NeuralModule.FRONTAL]: 'text-sky-400 border-sky-400/20 bg-sky-400/5',
  [NeuralModule.BROCA]: 'text-teal-400 border-teal-400/20 bg-teal-400/5',
  [NeuralModule.SLEEP]: 'text-blue-300 border-blue-300/20 bg-blue-300/5',
  [NeuralModule.REM]: 'text-purple-400 border-purple-400/20 bg-purple-400/5',
  [NeuralModule.DREAM]: 'text-fuchsia-400 border-fuchsia-400/20 bg-fuchsia-400/5',
  [NeuralModule.SYSTEM]: 'text-muted-foreground border-border/30 bg-muted/20',
};

const severityDots = {
  [EventSeverity.INFO]: 'bg-neon-cyan',
  [EventSeverity.WARNING]: 'bg-neon-amber',
  [EventSeverity.ERROR]: 'bg-neon-red',
  [EventSeverity.DEBUG]: 'bg-muted-foreground/50',
};

export default function NeuralEventItem({ event, compact = false }) {
  const colorClasses = moduleColors[event.module] || moduleColors[NeuralModule.SYSTEM];

  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/20 hover:bg-secondary/20 transition-colors">
        <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', severityDots[event.severity])} />
        <span className="text-[10px] font-mono text-muted-foreground/60 w-16 flex-shrink-0">
          {new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
        <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded border', colorClasses, 'w-20 text-center flex-shrink-0')}>
          {event.module}
        </span>
        <span className="text-xs text-foreground/80 truncate">{event.summary}</span>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-border/20 hover:bg-secondary/10 transition-colors">
      <div className="flex items-start gap-3">
        <span className={cn('w-2 h-2 rounded-full flex-shrink-0 mt-1.5', severityDots[event.severity])} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded border', colorClasses)}>
              {event.module}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground/60">
              {new Date(event.timestamp).toLocaleTimeString()}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground/40">
              {event.duration}ms
            </span>
            <span className="text-[10px] font-mono text-muted-foreground/30 ml-auto">
              {event.traceId}
            </span>
          </div>
          <p className="text-sm text-foreground/85 mt-1">{event.summary}</p>
          <div className="flex items-center gap-2 mt-1.5">
            <span className={cn('text-[9px] font-mono px-1.5 py-0.5 rounded', {
              'bg-neon-green/10 text-neon-green': event.privacyLevel === PrivacyLevel.PUBLIC,
              'bg-neon-cyan/10 text-neon-cyan': event.privacyLevel === PrivacyLevel.SAFE_SUMMARY,
              'bg-neon-amber/10 text-neon-amber': event.privacyLevel === PrivacyLevel.PRIVATE_METADATA,
              'bg-neon-red/10 text-neon-red': event.privacyLevel === PrivacyLevel.REDACTED,
            })}>
              {event.privacyLevel}
            </span>
            <span className="text-[9px] font-mono text-muted-foreground/30 uppercase">
              {event.eventType}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}