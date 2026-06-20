import React, { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  Pause, Play, ArrowDown, Search, Filter, Download, Rows3, Rows4,
  Trash2, X
} from 'lucide-react';
import { NeuralModule, EventSeverity, PrivacyLevel } from '@/integrations/floki/types';
import flokiAdapter from '@/integrations/floki/adapter';
import NeuralEventItem from './NeuralEventItem';
import { Input } from '@/components/ui/input';

const ALL_MODULES = Object.values(NeuralModule);
const ALL_SEVERITIES = Object.values(EventSeverity);
const ALL_PRIVACY = ['all', ...Object.values(PrivacyLevel)];
const MAX_EVENTS = 1000;

export default function NeuralStreamView() {
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [compact, setCompact] = useState(false);
  const [search, setSearch] = useState('');
  const [moduleFilter, setModuleFilter] = useState(new Set(ALL_MODULES));
  const [severityFilter, setSeverityFilter] = useState(new Set(ALL_SEVERITIES));
  const [privacyFilter, setPrivacyFilter] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (paused) return;
    let active = true;
    const refresh = async () => {
      try {
        const next = await flokiAdapter.getNeuralEvents(MAX_EVENTS);
        if (active) setEvents(next);
      } catch (error) {
        console.error(error);
      }
    };
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(interval); };
  }, [paused]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, autoScroll]);

  const filtered = events.filter(e => {
    if (!moduleFilter.has(e.module)) return false;
    if (!severityFilter.has(e.severity)) return false;
    if (privacyFilter !== 'all' && e.privacyLevel !== privacyFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return e.summary.toLowerCase().includes(q) || e.traceId.toLowerCase().includes(q) || e.module.toLowerCase().includes(q);
    }
    return true;
  });

  const toggleModule = (mod) => {
    setModuleFilter(prev => {
      const next = new Set(prev);
      if (next.has(mod)) next.delete(mod);
      else next.add(mod);
      return next;
    });
  };

  const toggleSeverity = (sev) => {
    setSeverityFilter(prev => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return next;
    });
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'neural-stream-export.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/50 bg-background/80 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">
            Neural Stream
          </h2>
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono text-muted-foreground mr-2">
              {filtered.length} / {events.length} events
            </span>
            <ToolBtn icon={paused ? Play : Pause} onClick={() => setPaused(!paused)} label={paused ? 'Resume' : 'Pause'} active={paused} />
            <ToolBtn icon={ArrowDown} onClick={() => { setAutoScroll(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }} label="Jump to newest" />
            <ToolBtn icon={compact ? Rows4 : Rows3} onClick={() => setCompact(!compact)} label={compact ? 'Expanded' : 'Compact'} />
            <ToolBtn icon={Filter} onClick={() => setShowFilters(!showFilters)} label="Filters" active={showFilters} />
            <ToolBtn icon={Download} onClick={handleExport} label="Export JSON" />
            <ToolBtn icon={Trash2} onClick={() => setEvents([])} label="Clear" />
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search events, trace IDs, modules..."
            className="pl-8 h-8 text-xs bg-secondary/30 border-border/30 focus-visible:ring-neon-cyan/30"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2">
              <X className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          )}
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div className="mt-3 space-y-2">
            {/* Module filters */}
            <div>
              <span className="text-[10px] font-mono text-muted-foreground block mb-1">Modules</span>
              <div className="flex flex-wrap gap-1">
                {ALL_MODULES.map(mod => (
                  <button
                    key={mod}
                    onClick={() => toggleModule(mod)}
                    className={cn(
                      'text-[9px] font-mono px-1.5 py-0.5 rounded border transition-colors',
                      moduleFilter.has(mod)
                        ? 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20'
                        : 'text-muted-foreground/40 border-border/20 hover:border-border/40'
                    )}
                  >
                    {mod}
                  </button>
                ))}
              </div>
            </div>

            {/* Severity filters */}
            <div>
              <span className="text-[10px] font-mono text-muted-foreground block mb-1">Severity</span>
              <div className="flex gap-1">
                {ALL_SEVERITIES.map(sev => (
                  <button
                    key={sev}
                    onClick={() => toggleSeverity(sev)}
                    className={cn(
                      'text-[9px] font-mono px-2 py-0.5 rounded border transition-colors capitalize',
                      severityFilter.has(sev)
                        ? 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20'
                        : 'text-muted-foreground/40 border-border/20'
                    )}
                  >
                    {sev}
                  </button>
                ))}
              </div>
            </div>

            {/* Privacy filter */}
            <div>
              <span className="text-[10px] font-mono text-muted-foreground block mb-1">Privacy</span>
              <div className="flex gap-1">
                {ALL_PRIVACY.map(p => (
                  <button
                    key={p}
                    onClick={() => setPrivacyFilter(p)}
                    className={cn(
                      'text-[9px] font-mono px-2 py-0.5 rounded border transition-colors',
                      privacyFilter === p
                        ? 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20'
                        : 'text-muted-foreground/40 border-border/20'
                    )}
                  >
                    {p === 'all' ? 'All' : p}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Event list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        onScroll={() => {
          if (!scrollRef.current) return;
          const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
          if (scrollHeight - scrollTop - clientHeight > 50) {
            setAutoScroll(false);
          }
        }}
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground/40 text-sm font-mono">
            {paused ? 'Stream paused' : 'Waiting for events...'}
          </div>
        ) : (
          filtered.map(event => (
            <NeuralEventItem key={event.id} event={event} compact={compact} />
          ))
        )}
      </div>
    </div>
  );
}

function ToolBtn({ icon: Icon, onClick, label, active }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'p-1.5 rounded-md transition-colors',
        active ? 'bg-neon-cyan/10 text-neon-cyan' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/40'
      )}
      aria-label={label}
      title={label}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}