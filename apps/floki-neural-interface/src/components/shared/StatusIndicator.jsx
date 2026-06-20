import React from 'react';
import { cn } from '@/lib/utils';

const statusColors = {
  online: 'bg-neon-green',
  active: 'bg-neon-green',
  running: 'bg-neon-green',
  healthy: 'bg-neon-green',
  live: 'bg-neon-green',
  fresh: 'bg-neon-cyan',
  idle: 'bg-neon-cyan',
  connected: 'bg-neon-green',
  warning: 'bg-neon-amber',
  slow: 'bg-neon-amber',
  aging: 'bg-neon-amber',
  degraded: 'bg-neon-amber',
  error: 'bg-neon-red',
  critical: 'bg-neon-red',
  offline: 'bg-muted-foreground',
  stopped: 'bg-muted-foreground',
  stale: 'bg-muted-foreground',
  disconnected: 'bg-neon-red',
  sleeping: 'bg-neon-blue',
  dreaming: 'bg-neon-cyan',
};

export default function StatusIndicator({ status, label, size = 'sm', pulse = true, className = '' }) {
  const color = statusColors[status?.toLowerCase()] || 'bg-muted-foreground';
  const dotSize = size === 'xs' ? 'w-1.5 h-1.5' : size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="relative flex">
        <span className={cn(dotSize, 'rounded-full', color)} />
        {pulse && (
          <span className={cn(dotSize, 'absolute rounded-full animate-ping opacity-40', color)} />
        )}
      </span>
      {label && (
        <span className="text-xs font-mono text-muted-foreground">{label}</span>
      )}
    </div>
  );
}