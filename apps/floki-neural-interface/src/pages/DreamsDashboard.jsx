import React, { useState, useEffect, useMemo } from 'react';
import flokiAdapter from '@/integrations/floki/adapter';
import DreamsHeader from '@/components/dreams/DreamsHeader';
import DreamsTimeline from '@/components/dreams/DreamsTimeline';
import DreamFragmentCard from '@/components/dreams/DreamFragmentCard';
import DreamsFilters from '@/components/dreams/DreamsFilters';

function fragmentMatches(frag, filters) {
  // Emotional tag filter
  if (filters.emotionalTag !== 'all') {
    const v = frag.emotionalTone.valence;
    const a = frag.emotionalTone.arousal;
    const tag = filters.emotionalTag;

    if (tag === 'peaceful' && !(v > 0.55 && a < 0.45)) return false;
    if (tag === 'vivid' && !(a > 0.6)) return false;
    if (tag === 'anxious' && !(v < 0.45 && a > 0.55)) return false;
    if (tag === 'euphoric' && !(v > 0.55 && a > 0.55)) return false;
    if (tag === 'melancholic' && !(v < 0.45 && a < 0.45)) return false;
    if (tag === 'neutral' && !(v >= 0.4 && v <= 0.6 && a >= 0.35 && a <= 0.6)) return false;
  }

  // Duration filter
  if (filters.duration !== 'all') {
    const s = frag.duration / 1000;
    if (filters.duration === 'short' && s >= 30) return false;
    if (filters.duration === 'medium' && (s < 30 || s > 90)) return false;
    if (filters.duration === 'long' && s <= 90) return false;
  }

  // Memory tag filter
  if (filters.selectedTags.length > 0) {
    if (!filters.selectedTags.some(tag => frag.memoryTags.includes(tag))) return false;
  }

  return true;
}

export default function DreamsDashboard() {
  const [timeline, setTimeline] = useState(null);
  const [selectedFragment, setSelectedFragment] = useState(null);
  const [filters, setFilters] = useState({ emotionalTag: 'all', duration: 'all', selectedTags: [] });

  useEffect(() => {
    flokiAdapter.getDreamTimeline().then(setTimeline).catch(console.error);
  }, []);

  const handleRefresh = async () => {
    setTimeline(await flokiAdapter.getDreamTimeline());
    setSelectedFragment(null);
  };

  const matchingFragmentIds = useMemo(() => {
    if (!timeline) return new Set();
    const match = new Set();
    timeline.fragments.forEach(frag => {
      if (fragmentMatches(frag, filters)) match.add(frag.id);
    });
    return match;
  }, [timeline, filters]);

  const activeFilterCount = (filters.emotionalTag !== 'all' ? 1 : 0) + (filters.duration !== 'all' ? 1 : 0) + filters.selectedTags.length;

  const filteredFragments = useMemo(() => {
    if (!timeline) return [];
    return timeline.fragments.filter(f => matchingFragmentIds.has(f.id));
  }, [timeline, matchingFragmentIds]);

  if (!timeline) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 mx-auto rounded-full border-2 border-neon-cyan/30 border-t-neon-cyan animate-spin" />
          <p className="text-xs text-muted-foreground font-mono">LOADING DREAM DATA...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        <DreamsHeader
          timeline={timeline}
          filteredCount={filteredFragments.length}
          hasActiveFilters={activeFilterCount > 0}
          onRefresh={handleRefresh}
        />

        {/* Layout: filters sidebar + main area */}
        <div className="flex flex-col lg:flex-row gap-6">
          <DreamsFilters
            fragments={timeline.fragments}
            filters={filters}
            onFiltersChange={setFilters}
          />

          <div className="flex-1 min-w-0">
            {/* Timeline + fragment detail in two columns */}
            <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
              <div className="xl:col-span-3">
                <DreamsTimeline
                  timeline={timeline}
                  selectedFragmentId={selectedFragment?.id}
                  matchingFragmentIds={matchingFragmentIds}
                  onSelectFragment={setSelectedFragment}
                />
              </div>
              <div className="xl:col-span-2">
                {selectedFragment ? (
                  <DreamFragmentCard
                    fragment={selectedFragment}
                    onClose={() => setSelectedFragment(null)}
                  />
                ) : (
                  <div className="glass-panel rounded-lg p-8 text-center border border-border/50 flex flex-col items-center justify-center min-h-[300px]">
                    <div className="w-14 h-14 mb-4 rounded-full bg-neon-cyan/5 border border-neon-cyan/10 flex items-center justify-center">
                      <svg className="w-6 h-6 text-neon-cyan/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                      </svg>
                    </div>
                    <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-1">
                      Select a dream fragment
                    </p>
                    <p className="text-[11px] text-muted-foreground/50 max-w-[220px] leading-relaxed">
                      Click any dot on the nocturnal timeline to view the full subconscious memory
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}