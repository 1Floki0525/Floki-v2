import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, Pause, Play, Search, Trash2 } from 'lucide-react';
import flokiAdapter from '@/integrations/floki/adapter';
import NeuralEventItem from './NeuralEventItem';
import { Input } from '@/components/ui/input';

const MAX_EVENTS = 1000;

export default function NeuralStreamView() {
  const [events, setEvents] = useState([]);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef(null);

  useEffect(() => {
    let active = true;
    let unsubscribe = null;
    const refresh = async () => {
      const next = await flokiAdapter.getNeuralEvents(MAX_EVENTS);
      if (active && !paused) setEvents(Array.isArray(next) ? next : []);
    };
    void refresh().catch((error) => console.error('inner stream refresh failed', error));
    flokiAdapter.subscribeRuntimeEvents((event) => {
      if (!active || paused || event?.type !== 'inner-stream.entry') return;
      setEvents((previous) => [...previous.filter((item) => item.id !== event.data.id), event.data].slice(-MAX_EVENTS));
    }).then((stop) => { if (active) unsubscribe = stop; else stop(); }).catch((error) => console.error('inner stream event connection failed', error));
    return () => { active = false; if (unsubscribe) unsubscribe(); };
  }, [paused]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events, autoScroll]);

  const filtered = events.filter((event) => {
    if (!search) return true;
    const query = search.toLowerCase();
    return String(event.summary || '').toLowerCase().includes(query) || String(event.category || '').toLowerCase().includes(query);
  });

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border/50 bg-background/80 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">Neural Stream</h2>
            <p className="text-[10px] text-muted-foreground mt-1">Floki’s private first-person perception, attention, emotion, memory, intention, reflection, and dream activity.</p>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono text-muted-foreground mr-2">{filtered.length} entries</span>
            <button onClick={() => setPaused(!paused)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground" title={paused ? 'Resume' : 'Pause'}>{paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}</button>
            <button onClick={() => { setAutoScroll(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground" title="Jump to newest"><ArrowDown className="w-3.5 h-3.5" /></button>
            <button onClick={() => setEvents([])} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground" title="Clear local view"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Floki’s inner experience..." className="pl-8 h-8 text-xs bg-secondary/30 border-border/30" />
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto" onScroll={() => { if (!scrollRef.current) return; const { scrollTop, scrollHeight, clientHeight } = scrollRef.current; if (scrollHeight - scrollTop - clientHeight > 50) setAutoScroll(false); }}>
        {filtered.length === 0 ? <div className="flex items-center justify-center h-full text-muted-foreground/40 text-sm font-mono">{paused ? 'Stream paused' : 'Waiting for Floki’s inner experience...'}</div> : filtered.map((event) => <NeuralEventItem key={event.id} event={event} />)}
      </div>
    </div>
  );
}
