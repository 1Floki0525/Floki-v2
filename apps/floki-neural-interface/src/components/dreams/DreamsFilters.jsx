import React, { useMemo } from 'react';
import { Filter, X, Zap, Cloud, Flame, Coffee, Clock, Tag, Sparkles, HeartPulse } from 'lucide-react';
import { cn } from '@/lib/utils';

const EMOTIONAL_TAGS = [
  { id: 'all', label: 'All', icon: null, description: '' },
  { id: 'peaceful', label: 'Peaceful', icon: Cloud, color: 'text-neon-green', bg: 'bg-neon-green/10', border: 'border-neon-green/30', desc: 'Calm, serene dreams' },
  { id: 'vivid', label: 'Vivid', icon: Sparkles, color: 'text-neon-amber', bg: 'bg-neon-amber/10', border: 'border-neon-amber/30', desc: 'Intensely clear & detailed' },
  { id: 'anxious', label: 'Anxious', icon: Zap, color: 'text-neon-red', bg: 'bg-neon-red/10', border: 'border-neon-red/30', desc: 'Tense, restless dreams' },
  { id: 'euphoric', label: 'Euphoric', icon: Flame, color: 'text-neon-cyan', bg: 'bg-neon-cyan/10', border: 'border-neon-cyan/30', desc: 'Joyful, exhilarating dreams' },
  { id: 'melancholic', label: 'Melancholic', icon: Cloud, color: 'text-neon-blue', bg: 'bg-neon-blue/10', border: 'border-neon-blue/30', desc: 'Somber, wistful dreams' },
  { id: 'neutral', label: 'Neutral', icon: Coffee, color: 'text-muted-foreground', bg: 'bg-secondary', border: 'border-border', desc: 'Balanced, uneventful dreams' },
];

const DURATION_OPTIONS = [
  { id: 'all', label: 'Any Duration' },
  { id: 'short', label: 'Brief (<30s)' },
  { id: 'medium', label: 'Medium (30–90s)' },
  { id: 'long', label: 'Extended (>90s)' },
];

function collectAllTags(fragments) {
  const tags = new Set();
  fragments.forEach(f => f.memoryTags.forEach(t => tags.add(t)));
  return [...tags].sort();
}

export default function DreamsFilters({ fragments, filters, onFiltersChange }) {
  const allTags = useMemo(() => collectAllTags(fragments), [fragments]);

  const activeCount =
    (filters.emotionalTag !== 'all' ? 1 : 0) +
    (filters.duration !== 'all' ? 1 : 0) +
    filters.selectedTags.length;

  const handleClearAll = () => {
    onFiltersChange({ emotionalTag: 'all', duration: 'all', selectedTags: [] });
  };

  const handleTagToggle = (tag) => {
    const next = filters.selectedTags.includes(tag)
      ? filters.selectedTags.filter(t => t !== tag)
      : [...filters.selectedTags, tag];
    onFiltersChange({ ...filters, selectedTags: next });
  };

  return (
    <aside className="w-full lg:w-56 flex-shrink-0 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-neon-cyan/70" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-neon-cyan/80">Filter Log</span>
          {activeCount > 0 && (
            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full bg-neon-cyan/15 text-neon-cyan border border-neon-cyan/30">
              {activeCount}
            </span>
          )}
        </div>
        {activeCount > 0 && (
          <button
            onClick={handleClearAll}
            className="flex items-center gap-1 text-[9px] font-mono text-muted-foreground hover:text-neon-red transition-colors"
          >
            <X className="w-2.5 h-2.5" />
            Clear
          </button>
        )}
      </div>

      {/* Emotional Tags */}
      <div className="space-y-1.5">
        <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5">
          <HeartPulse className="w-3 h-3" />
          Emotional State
        </span>
        <div className="space-y-0.5">
          {EMOTIONAL_TAGS.map(tag => {
            const isActive = filters.emotionalTag === tag.id;
            const Icon = tag.icon;
            return (
              <button
                key={tag.id}
                onClick={() => onFiltersChange({ ...filters, emotionalTag: tag.id })}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-all border',
                  isActive
                    ? cn(tag.bg, tag.border, tag.color, 'shadow-[0_0_6px_hsl(var(--neon-cyan)/0.15)]')
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/40'
                )}
              >
                {Icon && <Icon className={cn('w-3 h-3 flex-shrink-0', isActive ? tag.color : 'text-muted-foreground')} />}
                <div className="min-w-0">
                  <span className={cn('text-[11px] font-mono block', isActive && 'font-medium')}>
                    {tag.label}
                  </span>
                  {tag.desc && isActive && (
                    <span className="text-[9px] text-muted-foreground block mt-0.5 leading-tight">
                      {tag.desc}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Duration */}
      <div className="space-y-1.5">
        <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5">
          <Clock className="w-3 h-3" />
          Duration
        </span>
        <div className="space-y-0.5">
          {DURATION_OPTIONS.map(opt => {
            const isActive = filters.duration === opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => onFiltersChange({ ...filters, duration: opt.id })}
                className={cn(
                  'w-full text-left px-3 py-1.5 rounded-md text-[10px] font-mono transition-all border',
                  isActive
                    ? 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/40'
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Memory Tags */}
      <div className="space-y-1.5">
        <span className="text-[9px] font-mono text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1.5">
          <Tag className="w-3 h-3" />
          Memory Fragments
        </span>
        <div className="flex flex-wrap gap-1">
          {allTags.map(tag => {
            const isSelected = filters.selectedTags.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => handleTagToggle(tag)}
                className={cn(
                  'px-2 py-1 rounded-full text-[9px] font-mono transition-all border',
                  isSelected
                    ? 'bg-neon-blue/15 text-neon-blue border-neon-blue/40'
                    : 'bg-secondary/30 text-muted-foreground border-transparent hover:text-foreground hover:border-border'
                )}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}