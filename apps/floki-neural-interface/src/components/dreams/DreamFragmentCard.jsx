import React from 'react';
import { format } from 'date-fns';
import { X, Tag, Image, Heart, Clock, Brain, Sparkles, Eye, Moon } from 'lucide-react';
import NeonPanel from '@/components/shared/NeonPanel';
import { cn } from '@/lib/utils';

function getEmotionalLabel(valence, arousal) {
  if (valence > 0.55 && arousal > 0.55) return { label: 'Euphoric', color: 'text-neon-cyan', glow: 'shadow-[0_0_12px_hsl(185,100%,50%,0.2)]' };
  if (valence > 0.55 && arousal < 0.45) return { label: 'Peaceful', color: 'text-neon-green', glow: 'shadow-[0_0_12px_hsl(140,70%,50%,0.2)]' };
  if (valence < 0.45 && arousal > 0.55) return { label: 'Anxious', color: 'text-neon-red', glow: 'shadow-[0_0_12px_hsl(0,72%,51%,0.2)]' };
  if (valence < 0.45 && arousal < 0.45) return { label: 'Melancholic', color: 'text-neon-blue', glow: 'shadow-[0_0_12px_hsl(210,100%,55%,0.2)]' };
  if (arousal > 0.6) return { label: 'Vivid', color: 'text-neon-amber', glow: 'shadow-[0_0_12px_hsl(38,92%,50%,0.2)]' };
  return { label: 'Neutral', color: 'text-muted-foreground', glow: '' };
}

export default function DreamFragmentCard({ fragment, onClose }) {
  const intensityPercent = Math.round(fragment.intensity * 100);
  const valencePercent = Math.round(fragment.emotionalTone.valence * 100);
  const arousalPercent = Math.round(fragment.emotionalTone.arousal * 100);
  const emotional = getEmotionalLabel(fragment.emotionalTone.valence, fragment.emotionalTone.arousal);

  // Map valence/arousal to coordinates for the 2D quadrant (0-100%)
  const dotX = valencePercent;
  const dotY = 100 - arousalPercent; // invert Y so high arousal is at top

  return (
    <NeonPanel
      title={fragment.isLucid ? 'Lucid Fragment' : 'Dream Fragment'}
      badge={fragment.isLucid ? 'LUCID' : undefined}
      className="sticky top-6"
      glow={fragment.isLucid}
    >
      <button
        onClick={onClose}
        className="absolute top-3 right-3 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
        aria-label="Close fragment detail"
      >
        <X className="w-3.5 h-3.5" />
      </button>

      <div className="space-y-5 mt-1">
        {/* Subconscious Memory Fragment */}
        <div className="relative">
          <div className="flex items-center gap-2 mb-2">
            <Brain className="w-3.5 h-3.5 text-neon-cyan/60" />
            <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">
              Subconscious Memory Fragment
            </span>
          </div>
          <div className="bg-gradient-to-br from-secondary/60 via-secondary/40 to-secondary/20 rounded-lg p-4 border border-border/40">
            <p className="text-sm leading-relaxed text-foreground/90 italic">
              &ldquo;{fragment.narrative}&rdquo;
            </p>
            {fragment.isLucid && (
              <div className="mt-3 flex items-center gap-2 text-[10px] font-mono text-neon-cyan">
                <Eye className="w-3 h-3" />
                <span>Lucid awareness detected — dreamer had conscious control</span>
              </div>
            )}
          </div>
        </div>

        {/* Emotional Intensity Quadrant */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Heart className="w-3.5 h-3.5 text-neon-red/60" />
            <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">
              Emotional Intensity
            </span>
            <span className={cn(
              'ml-auto text-[10px] font-mono font-medium px-2 py-0.5 rounded-full border',
              emotional.color,
              'bg-current/10 border-current/20'
            )}>
              {emotional.label}
            </span>
          </div>

          {/* 2D Valence-Arousal Quadrant */}
          <div className={cn(
            'bg-secondary/40 rounded-lg p-3 border border-border/30',
            emotional.glow
          )}>
            {/* Quadrant grid */}
            <div className="relative aspect-square max-w-[200px] mx-auto">
              {/* Axes */}
              <div className="absolute inset-0">
                <div className="absolute top-1/2 left-0 right-0 h-px bg-border/60" />
                <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border/60" />
              </div>

              {/* Quadrant labels */}
              <span className="absolute top-1 left-1/2 -translate-x-1/2 text-[7px] font-mono text-muted-foreground/50">
                High Arousal
              </span>
              <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[7px] font-mono text-muted-foreground/50">
                Low Arousal
              </span>
              <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[7px] font-mono text-muted-foreground/50 rotate-180 [writing-mode:vertical-rl]">
                Low Valence
              </span>
              <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[7px] font-mono text-muted-foreground/50 [writing-mode:vertical-rl]">
                High Valence
              </span>

              {/* Quadrant zones */}
              <div className="absolute top-0 right-0 w-1/2 h-1/2 bg-neon-cyan/5 rounded-br-lg" />
              <div className="absolute top-0 left-0 w-1/2 h-1/2 bg-neon-red/5 rounded-bl-lg" />
              <div className="absolute bottom-0 right-0 w-1/2 h-1/2 bg-neon-green/5 rounded-tr-lg" />
              <div className="absolute bottom-0 left-0 w-1/2 h-1/2 bg-neon-blue/5 rounded-tl-lg" />

              {/* Data dot */}
              <div
                className="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-neon-cyan bg-neon-cyan/30 shadow-[0_0_10px_hsl(185,100%,50%,0.4)] transition-all"
                style={{ left: `${dotX}%`, top: `${dotY}%` }}
              >
                <div className="absolute inset-0 rounded-full bg-neon-cyan animate-ping opacity-30" />
              </div>
            </div>

            {/* Bar meters */}
            <div className="space-y-2 mt-3">
              <div>
                <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                  <span className="text-muted-foreground">Valence</span>
                  <span className="text-neon-green">{valencePercent}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full rounded-full bg-neon-green transition-all duration-500"
                    style={{ width: `${valencePercent}%` }}
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                  <span className="text-muted-foreground">Arousal</span>
                  <span className="text-neon-amber">{arousalPercent}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                  <div
                    className="h-full rounded-full bg-neon-amber transition-all duration-500"
                    style={{ width: `${arousalPercent}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-secondary/30 rounded-md p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Moon className="w-3 h-3 text-neon-cyan/50" />
              <span className="text-[9px] text-muted-foreground font-mono uppercase tracking-wider">REM Cycle</span>
            </div>
            <p className="text-xs font-mono text-neon-cyan">#{fragment.remCycleIndex} — {fragment.cyclePhase}</p>
          </div>
          <div className="bg-secondary/30 rounded-md p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Clock className="w-3 h-3 text-muted-foreground/50" />
              <span className="text-[9px] text-muted-foreground font-mono uppercase tracking-wider">Timestamp</span>
            </div>
            <p className="text-xs font-mono text-foreground">
              {format(new Date(fragment.timestamp), 'HH:mm:ss')}
            </p>
          </div>
          <div className="bg-secondary/30 rounded-md p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Clock className="w-3 h-3 text-muted-foreground/50" />
              <span className="text-[9px] text-muted-foreground font-mono uppercase tracking-wider">Duration</span>
            </div>
            <p className="text-xs font-mono text-foreground">
              {Math.round(fragment.duration / 1000)}s
            </p>
          </div>
          <div className="bg-secondary/30 rounded-md p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <Sparkles className="w-3 h-3 text-neon-amber/50" />
              <span className="text-[9px] text-muted-foreground font-mono uppercase tracking-wider">Intensity</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-full bg-neon-cyan transition-all"
                  style={{ width: `${intensityPercent}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-neon-cyan">{intensityPercent}%</span>
            </div>
          </div>
        </div>

        {/* Memory Tags */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Tag className="w-3 h-3 text-neon-blue/70" />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Memory Tags</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {fragment.memoryTags.map(tag => (
              <span
                key={tag}
                className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-neon-blue/10 text-neon-blue border border-neon-blue/20"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Visual Elements */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Image className="w-3 h-3 text-neon-green/70" />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Visual Elements</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {fragment.visualElements.map(el => (
              <span
                key={el}
                className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-neon-green/10 text-neon-green border border-neon-green/20"
              >
                {el}
              </span>
            ))}
          </div>
        </div>
      </div>
    </NeonPanel>
  );
}