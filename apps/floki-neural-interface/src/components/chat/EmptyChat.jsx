import React from 'react';
import { Bot, Zap, Eye, Brain, Ear } from 'lucide-react';

export default function EmptyChat() {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 rounded-2xl bg-neon-cyan/10 border border-neon-cyan/20 flex items-center justify-center mx-auto mb-6">
          <Bot className="w-8 h-8 text-neon-cyan/80" />
        </div>
        <h2 className="text-lg font-semibold text-foreground mb-2">Floki Neural Interface</h2>
        <p className="text-sm text-muted-foreground mb-8">
          Start a conversation with Floki. Type a message or use voice input.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {[
            { icon: Brain, label: 'Cognition Active' },
            { icon: Eye, label: 'Vision Online' },
            { icon: Ear, label: 'Hearing Ready' },
            { icon: Zap, label: 'Memory Loaded' },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border/30">
              <item.icon className="w-3.5 h-3.5 text-neon-cyan/60" />
              <span className="text-xs text-muted-foreground">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}