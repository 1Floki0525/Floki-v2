import React from 'react';
import { Bot, Zap, Eye, Brain, Ear, Volume2 } from 'lucide-react';

export default function EmptyChat({ flokiStatus = {} }) {
  const items = [
    { icon: Brain, label: 'Cognition', ready: flokiStatus.connected === true },
    { icon: Eye, label: 'Vision', ready: flokiStatus.visionActive === true },
    { icon: Ear, label: 'Hearing', ready: flokiStatus.hearingActive === true },
    { icon: Volume2, label: 'Speech', ready: flokiStatus.speechActive === true },
    { icon: Zap, label: 'Memory', ready: flokiStatus.memoryLoaded === true },
  ];

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 rounded-2xl bg-neon-cyan/10 border border-neon-cyan/20 flex items-center justify-center mx-auto mb-6">
          <Bot className="w-8 h-8 text-neon-cyan/80" />
        </div>
        <h2 className="text-lg font-semibold text-foreground mb-2">Floki Neural Interface</h2>
        <p className="text-sm text-muted-foreground mb-8">
          Start a conversation with Floki. Type a message or speak to him while hearing is online.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {items.map((item) => (
            <div key={item.label} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border/30">
              <item.icon className={item.ready ? 'w-3.5 h-3.5 text-neon-cyan/80' : 'w-3.5 h-3.5 text-muted-foreground/40'} />
              <span className="text-xs text-muted-foreground">
                {item.label}: {item.ready ? 'Ready' : 'Offline'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
