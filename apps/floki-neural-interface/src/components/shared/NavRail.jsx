import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { MessageSquare, Activity, Server, Settings, ChevronLeft, ChevronRight, Zap, Brain } from 'lucide-react';
import StatusIndicator from './StatusIndicator';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';

const NAV_ITEMS = [
  { id: 'chat', label: 'Chat Interface', icon: MessageSquare },
  { id: 'dreams', label: 'Dreams', icon: Brain },
  { id: 'neural', label: 'Neural Stream', icon: Activity },
  { id: 'system', label: 'System', icon: Server },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function NavRail({ activeTab, onTabChange, flokiStatus }) {
  const [collapsed, setCollapsed] = useState(false);

  const status = {
    online: flokiStatus?.connected === true ? 'online' : 'offline',
    vision: flokiStatus?.visionActive === true ? 'active' : 'offline',
    hearing: flokiStatus?.hearingActive === true ? 'active' : 'offline',
    sleep: (flokiStatus?.sleepState || '').toLowerCase().includes('sleep') || (flokiStatus?.sleepState || '').toLowerCase().includes('rem') || (flokiStatus?.sleepState || '').toLowerCase().includes('dream') ? 'sleeping' : 'active',
  };

  return (
    <TooltipProvider delayDuration={200}>
      <nav
        className={cn(
          'flex flex-col h-full border-r border-border/50 bg-background/95 backdrop-blur-sm transition-all duration-300',
          collapsed ? 'w-16' : 'w-56'
        )}
        role="navigation"
        aria-label="Main navigation"
      >
        {/* Header */}
        <div className="px-3 pt-4 pb-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-neon-cyan/10 border border-neon-cyan/30 flex items-center justify-center flex-shrink-0">
              <Zap className="w-4 h-4 text-neon-cyan" />
            </div>
            {!collapsed && (
              <div className="overflow-hidden">
                <h1 className="text-xs font-bold tracking-[0.15em] uppercase text-neon-cyan neon-text whitespace-nowrap">
                  Floki Neural
                </h1>
                <p className="text-[10px] font-mono text-muted-foreground tracking-wider">INTERFACE</p>
              </div>
            )}
          </div>
        </div>

        {/* Status indicators */}
        {!collapsed && (
          <div className="px-3 py-3 border-b border-border/50 space-y-1.5">
            <StatusIndicator status={status.online} label={flokiStatus?.online ? 'Floki Online' : 'Floki Offline'} size="xs" />
            <StatusIndicator status="active" label={flokiStatus?.mode || 'chat.local'} size="xs" pulse={false} />
            <StatusIndicator status={status.vision} label="Vision" size="xs" pulse={false} />
            <StatusIndicator status={status.hearing} label="Hearing" size="xs" pulse={false} />
            <StatusIndicator status={status.sleep} label={flokiStatus?.sleepState || 'Unknown'} size="xs" pulse={false} />
          </div>
        )}

        {/* Nav items */}
        <div className="flex-1 py-2 px-2 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            const Icon = item.icon;
            const button = (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                data-testid={`nav-${item.id}`}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-md transition-all duration-200 group',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-cyan/50',
                  isActive
                    ? 'bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/20'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50 border border-transparent'
                )}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon className={cn('w-4 h-4 flex-shrink-0', isActive && 'drop-shadow-[0_0_6px_hsl(185,100%,50%)]')} />
                {!collapsed && (
                  <span className="text-sm font-medium truncate">{item.label}</span>
                )}
                {item.id === 'system' && Number(flokiStatus?.selfImprovementPending || 0) > 0 && (
                  <span className="ml-auto min-w-5 h-5 px-1 rounded-full bg-orange-500/20 border border-orange-500/40 text-orange-300 text-[10px] font-mono flex items-center justify-center">
                    {Number(flokiStatus.selfImprovementPending)}
                  </span>
                )}
              </button>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>{button}</TooltipTrigger>
                  <TooltipContent side="right" className="bg-card border-border">
                    {item.label}
                  </TooltipContent>
                </Tooltip>
              );
            }
            return <React.Fragment key={item.id}>{button}</React.Fragment>;
          })}
        </div>

        {/* Collapse toggle */}
        <div className="p-2 border-t border-border/50">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="w-full flex items-center justify-center p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>
      </nav>
    </TooltipProvider>
  );
}
