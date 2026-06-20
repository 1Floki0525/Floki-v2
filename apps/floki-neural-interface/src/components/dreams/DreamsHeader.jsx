import React from 'react';
import { Brain, Moon, Zap, Clock, Eye, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import NeonPanel from '@/components/shared/NeonPanel';

function formatDuration(ms) {
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  return hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
}

export default function DreamsHeader({ timeline, onRefresh, filteredCount, hasActiveFilters }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-neon-cyan/10 border border-neon-cyan/20 flex items-center justify-center">
            <Brain className="w-4 h-4 text-neon-cyan" />
          </div>
          <div>
            <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">
              Dreams & REM Cycles
            </h2>
              <p className="text-[10px] text-muted-foreground font-mono">
                {timeline.sessionDate ? 'Session: ' + format(new Date(timeline.sessionDate), 'MMM d, yyyy h:mm a') : 'No recorded session'}
              </p>
          </div>
        </div>
        <button
          onClick={onRefresh}
          className="p-2 rounded-md text-muted-foreground hover:text-neon-cyan hover:bg-neon-cyan/5 transition-colors"
          aria-label="Refresh dream data"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
        <NeonPanel className="!p-0">
          <div className="px-3 py-2.5 flex items-center gap-2">
            <Moon className="w-3.5 h-3.5 text-neon-cyan/70" />
            <div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Duration</p>
              <p className="text-sm font-semibold text-foreground font-mono">
                {formatDuration(timeline.totalSleepDuration)}
              </p>
            </div>
          </div>
        </NeonPanel>
        <NeonPanel className="!p-0">
          <div className="px-3 py-2.5 flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-neon-amber/70" />
            <div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">REM Cycles</p>
              <p className="text-sm font-semibold text-foreground font-mono">{timeline.cycles.length}</p>
            </div>
          </div>
        </NeonPanel>
        <NeonPanel className="!p-0">
          <div className="px-3 py-2.5 flex items-center gap-2">
            <Brain className="w-3.5 h-3.5 text-neon-blue/70" />
            <div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Fragments</p>
              <p className="text-sm font-semibold text-foreground font-mono">
                {hasActiveFilters ? (
                  <>
                    <span className="text-neon-cyan">{filteredCount}</span>
                    <span className="text-muted-foreground/60"> / {timeline.totalFragments}</span>
                  </>
                ) : (
                  timeline.totalFragments
                )}
              </p>
            </div>
          </div>
        </NeonPanel>
        <NeonPanel className="!p-0">
          <div className="px-3 py-2.5 flex items-center gap-2">
            <Eye className="w-3.5 h-3.5 text-neon-green/70" />
            <div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Lucid</p>
              <p className="text-sm font-semibold text-foreground font-mono">{timeline.lucidMoments}</p>
            </div>
          </div>
        </NeonPanel>
        <NeonPanel className="!p-0 hidden lg:block">
          <div className="px-3 py-2.5 flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-neon-cyan/70" />
            <div>
              <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Theme</p>
              <p className="text-sm font-semibold text-foreground font-mono truncate">{timeline.dominantTheme}</p>
            </div>
          </div>
        </NeonPanel>
      </div>
    </div>
  );
}