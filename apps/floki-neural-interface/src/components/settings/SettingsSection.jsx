import React from 'react';
import { RotateCw } from 'lucide-react';

export default function SettingsSection({ title, children, onReset }) {
  return (
    <div className="glass-panel rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
        <h3 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">
          {title}
        </h3>
        {onReset && (
          <button
            onClick={onReset}
            className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-foreground transition-colors"
          >
            <RotateCw className="w-3 h-3" />
            Reset
          </button>
        )}
      </div>
      <div className="p-4 space-y-3">
        {children}
      </div>
    </div>
  );
}