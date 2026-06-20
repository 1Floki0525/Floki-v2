import React from 'react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import RemCycleBar from './RemCycleBar';

export default function DreamsTimeline({ timeline, selectedFragmentId, matchingFragmentIds, onSelectFragment }) {
  const { cycles, fragments } = timeline;
  if (!cycles.length) {
    return (
      <div className="glass-panel rounded-lg p-8 border border-border/50 text-center">
        <div className="w-10 h-10 mx-auto rounded-full bg-neon-cyan/5 border border-neon-cyan/10 flex items-center justify-center mb-3">
          <svg className="w-5 h-5 text-neon-cyan/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
        </div>
        <p className="text-[11px] font-mono text-muted-foreground uppercase tracking-wider">
          {fragments.length > 0 ? 'Dream fragments available without REM cycle data' : 'No dream data yet'}
        </p>
        <p className="text-[10px] text-muted-foreground/50 mt-1 max-w-[300px] mx-auto leading-relaxed">
          {fragments.length > 0
            ? 'REM cycle timeline will appear after Floki completes a sleep session.'
            : 'Dream fragments and REM cycles appear here after Floki sleeps and dreams.'}
        </p>
      </div>
    );
  }

  const sessionStart = new Date(timeline.sessionDate).getTime();
  const sessionEnd = cycles[cycles.length - 1].endTime;
  const totalSpan = sessionEnd - sessionStart;

  // Group fragments by cycle
  const fragmentsByCycle = {};
  fragments.forEach(f => {
    if (!fragmentsByCycle[f.remCycleIndex]) fragmentsByCycle[f.remCycleIndex] = [];
    fragmentsByCycle[f.remCycleIndex].push(f);
  });

  return (
    <div className="glass-panel rounded-lg p-6 border border-border/50">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">
          Nocturnal Timeline
        </h3>
        <span className="text-[10px] font-mono text-muted-foreground">
          {format(new Date(timeline.sessionDate), 'HH:mm')} – {format(sessionEnd, 'HH:mm')}
        </span>
      </div>

      {/* Timeline */}
      <div className="relative">
        {/* Time axis */}
        <div className="flex items-start pl-14">
          {/* Vertical line */}
          <div className="absolute left-[55px] top-0 bottom-0 w-px bg-neon-cyan/20" />

          {/* REM Cycles */}
          <div className="flex-1 space-y-0">
            {cycles.map((cycle, idx) => {
              const startOffset = ((cycle.startTime - sessionStart) / totalSpan) * 100;
              const width = (cycle.duration / totalSpan) * 100;

              return (
                <div key={cycle.id} className="relative" style={{ marginLeft: `${startOffset}%` }}>
                  <RemCycleBar
                    cycle={cycle}
                    width={width}
                    index={idx}
                  />

                  {/* Fragments within this cycle */}
                  {fragmentsByCycle[cycle.cycleNumber]?.map((frag, fragIdx) => {
                    const fragOffset = ((frag.timestamp - cycle.startTime) / cycle.duration) * 100;
                    const isSelected = selectedFragmentId === frag.id;
                    const isMatch = matchingFragmentIds ? matchingFragmentIds.has(frag.id) : true;
                    return (
                      <button
                        key={frag.id}
                        onClick={() => onSelectFragment(frag)}
                        className={cn(
                          'absolute top-full mt-1 w-3 h-3 rounded-full border transition-all duration-200 cursor-pointer',
                          'hover:scale-150 hover:z-10',
                          !isMatch && 'opacity-20 scale-75',
                          isSelected
                            ? 'bg-neon-cyan border-neon-cyan shadow-[0_0_8px_hsl(185,100%,50%,0.5)] opacity-100 scale-100'
                            : frag.isLucid
                              ? 'bg-neon-amber border-neon-amber/60'
                              : 'bg-neon-cyan/30 border-neon-cyan/40',
                        )}
                        style={{ left: `${fragOffset}%` }}
                        title={frag.narrative.slice(0, 50) + '...'}
                        aria-label={`Dream fragment: ${frag.narrative.slice(0, 40)}${!isMatch ? ' (filtered out)' : ''}`}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* Timeline labels */}
        <div className="absolute left-0 top-0 bottom-0 w-[50px] flex flex-col justify-between">
          <span className="text-[9px] font-mono text-muted-foreground/60">
            {format(new Date(timeline.sessionDate), 'HH:mm')}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground/60">
            {format(sessionEnd, 'HH:mm')}
          </span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-8 pt-4 border-t border-border/30">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-neon-cyan/30 border border-neon-cyan/40" />
          <span className="text-[10px] text-muted-foreground font-mono">Dream Fragment</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-neon-amber border border-neon-amber/60" />
          <span className="text-[10px] text-muted-foreground font-mono">Lucid Moment</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-neon-cyan border border-neon-cyan" />
          <span className="text-[10px] text-muted-foreground font-mono">Selected</span>
        </div>
      </div>
    </div>
  );
}