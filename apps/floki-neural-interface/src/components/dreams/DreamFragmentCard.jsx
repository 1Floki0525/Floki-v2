import React from 'react';
import { format } from 'date-fns';
import { BookOpen, Brain, Moon, Sparkles } from 'lucide-react';

function Paragraphs({ text }) {
  const paragraphs = String(text || '')
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!paragraphs.length) return <p className="text-sm text-muted-foreground">No narrative was saved for this dream.</p>;
  return paragraphs.map((paragraph, index) => (
    <p key={index} className="text-sm leading-7 text-foreground/90 whitespace-pre-wrap">{paragraph}</p>
  ));
}

export default function DreamFragmentCard({ dream, fragment }) {
  const item = dream || fragment;
  if (!item) return null;
  return (
    <article className="glass-panel rounded-lg border border-neon-cyan/20 overflow-hidden min-h-[360px]">
      <header className="px-6 py-5 border-b border-border/40 bg-neon-cyan/[0.03]">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-neon-cyan/10 border border-neon-cyan/20 flex items-center justify-center shrink-0">
            <Moon className="w-4 h-4 text-neon-cyan" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-neon-cyan/70">Dream transcript</p>
            <h3 className="mt-1 text-lg font-semibold leading-tight text-foreground">{item.title}</h3>
            <p className="mt-2 text-[10px] font-mono text-muted-foreground">
              {format(new Date(item.createdAt || item.timestamp), 'MMMM d, yyyy · h:mm:ss a')} · REM {item.remCycleNumber || item.remCycleIndex}
            </p>
          </div>
        </div>
      </header>

      <div className="p-6 space-y-6">
        <section>
          <div className="flex items-center gap-2 mb-3">
            <BookOpen className="w-4 h-4 text-neon-cyan/70" />
            <h4 className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">Full dream narrative</h4>
          </div>
          <div className="space-y-4"><Paragraphs text={item.story || item.transcript || item.narrative} /></div>
        </section>

        {item.reflection && (
          <section className="border-t border-border/30 pt-5">
            <div className="flex items-center gap-2 mb-3">
              <Brain className="w-4 h-4 text-neon-blue/70" />
              <h4 className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">First-person reflection</h4>
            </div>
            <p className="text-sm leading-6 text-foreground/80 whitespace-pre-wrap">{item.reflection}</p>
          </section>
        )}

        {item.consolidationSummary && (
          <section className="border-t border-border/30 pt-5">
            <h4 className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground mb-3">Memory consolidation</h4>
            <p className="text-sm leading-6 text-foreground/80 whitespace-pre-wrap">{item.consolidationSummary}</p>
          </section>
        )}

        {item.symbols?.length > 0 && (
          <section className="border-t border-border/30 pt-5">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-neon-amber/70" />
              <h4 className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">Symbols</h4>
            </div>
            <div className="flex flex-wrap gap-2">
              {item.symbols.map((symbol) => (
                <span key={symbol} className="px-2.5 py-1 rounded-full border border-neon-amber/20 bg-neon-amber/5 text-[10px] text-neon-amber/80">{symbol}</span>
              ))}
            </div>
          </section>
        )}
      </div>
    </article>
  );
}
