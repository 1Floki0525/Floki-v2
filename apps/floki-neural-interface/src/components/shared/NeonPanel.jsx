import React from 'react';
import { cn } from '@/lib/utils';

export default function NeonPanel({ children, className = '', title, badge, glow = false, ...props }) {
  return (
    <div
      className={cn(
        'glass-panel rounded-lg overflow-hidden',
        glow && 'neon-glow',
        className
      )}
      {...props}
    >
      {(title || badge) && (
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
          {title && (
            <h3 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">
              {title}
            </h3>
          )}
          {badge && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-neon-amber/15 text-neon-amber border border-neon-amber/30">
              {badge}
            </span>
          )}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}