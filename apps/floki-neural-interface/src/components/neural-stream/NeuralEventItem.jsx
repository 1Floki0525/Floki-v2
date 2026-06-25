import React from 'react';

export default function NeuralEventItem({ event }) {
  return (
    <div className="px-4 py-3 border-b border-border/20 hover:bg-secondary/10 transition-colors">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-neon-cyan/20 bg-neon-cyan/5 text-neon-cyan">{event.module || event.category || 'Reflection'}</span>
        <span className="text-[10px] font-mono text-muted-foreground/60">{new Date(event.timestamp).toLocaleTimeString()}</span>
      </div>
      <p className="text-sm text-foreground/90 mt-1.5 leading-relaxed">{event.summary}</p>
    </div>
  );
}
