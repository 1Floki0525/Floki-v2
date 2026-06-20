import React from 'react'
import { cn } from '@/lib/utils'
import { FileText, RotateCw } from 'lucide-react'
import { ServiceStatus } from '@/integrations/floki/types'

function formatUptime(ms) {
  const total = Math.max(0, Number(ms || 0))
  const hours = Math.floor(total / 3600000)
  const minutes = Math.floor((total % 3600000) / 60000)
  return `${hours}h ${minutes}m`
}

const statusStyles = {
  [ServiceStatus.RUNNING]: { dot: 'bg-neon-green', text: 'text-neon-green', label: 'Running' },
  [ServiceStatus.STOPPED]: { dot: 'bg-muted-foreground/50', text: 'text-muted-foreground', label: 'Stopped' },
  [ServiceStatus.DEGRADED]: { dot: 'bg-neon-amber', text: 'text-neon-amber', label: 'Degraded' },
}

export default function ServiceCard({ service, onRestart, onViewLogs }) {
  const style = statusStyles[service.status] || statusStyles[ServiceStatus.STOPPED]
  return (
    <div className="glass-panel rounded-lg p-4 hover:neon-glow transition-all duration-300" data-testid={`service-${service.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">{service.name}</h3>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={cn('w-2 h-2 rounded-full', style.dot)} />
            <span className={cn('text-[10px] font-mono', style.text)}>{style.label}</span>
          </div>
        </div>
        <span className="text-[10px] font-mono text-muted-foreground/50">{Math.round(Number(service.latency || 0))}ms</span>
      </div>
      <div className="space-y-1 mb-3">
        <div className="flex justify-between text-[10px] font-mono"><span className="text-muted-foreground">Uptime</span><span className="text-foreground/70">{formatUptime(service.uptime)}</span></div>
        <div className="flex justify-between text-[10px] font-mono"><span className="text-muted-foreground">Heartbeat</span><span className="text-foreground/70">{Math.max(0, Math.floor((Date.now() - Number(service.lastHeartbeat || Date.now())) / 1000))}s ago</span></div>
        {service.detail && <div className="text-[10px] font-mono text-muted-foreground/60 mt-1 line-clamp-2">{service.detail}</div>}
        {service.lastError && <div className="text-[10px] font-mono text-neon-red/80 mt-1 line-clamp-2">Error: {service.lastError}</div>}
      </div>
      <div className="flex items-center gap-1.5 min-h-7">
        {service.restartAvailable && (
          <button type="button" onClick={() => onRestart(service)} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors border border-border/30">
            <RotateCw className="w-3 h-3" /> Restart
          </button>
        )}
        {service.logAvailable && (
          <button type="button" onClick={() => onViewLogs(service)} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors border border-border/30">
            <FileText className="w-3 h-3" /> Logs
          </button>
        )}
        {!service.restartAvailable && !service.logAvailable && <span className="text-[10px] font-mono text-muted-foreground/50">Status-only module</span>}
      </div>
    </div>
  )
}
