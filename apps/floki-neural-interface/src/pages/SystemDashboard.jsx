import React, { useCallback, useEffect, useState } from 'react'
import flokiAdapter from '@/integrations/floki/adapter'
import { ServiceStatus } from '@/integrations/floki/types'
import ServiceCard from '@/components/system/ServiceCard'
import SystemControls from '@/components/system/SystemControls'
import { FlaskConical, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

function selfImprovementService(status) {
  const failed = status?.state === 'failed' || Boolean(status?.last_error)
  const running = status?.worker_running === true
  const state = String(status?.state || 'unknown').replaceAll('_', ' ')
  const phase = String(status?.phase || '').replaceAll('_', ' ')
  return {
    name: 'Recursive Self-Improvement',
    status: failed
      ? ServiceStatus.DEGRADED
      : running
        ? ServiceStatus.RUNNING
        : ServiceStatus.STOPPED,
    lastHeartbeat: status?.last_heartbeat_at
      ? Date.parse(status.last_heartbeat_at)
      : Date.now(),
    uptime: status?.started_at
      ? Math.max(0, Date.now() - Date.parse(status.started_at))
      : 0,
    latency: 0,
    lastError: status?.last_error || null,
    detail: [
      running ? 'Worker running' : 'Worker stopped',
      state,
      phase
    ].filter(Boolean).join(' · '),
    restartAvailable: false,
    logAvailable: true,
    logKey: 'Self-Improvement Worker'
  }
}

export default function SystemDashboard({ onNavigate }) {
  const [services, setServices] = useState([])
  const [busyAction, setBusyAction] = useState(null)
  const pollMsRef = React.useRef(null)

  const loadServices = useCallback(async () => {
    const [next, rsiStatus] = await Promise.all([
      flokiAdapter.getSystemStatus(),
      flokiAdapter.getSelfImprovementStatus()
    ])
    const pollMs = Number(rsiStatus?.ui_poll_ms)
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new Error('self_improvement.ui_poll_ms is invalid')
    }
    return {
      rows: [
        ...(Array.isArray(next) ? next : []),
        selfImprovementService(rsiStatus)
      ],
      pollMs
    }
  }, [])

  const refresh = useCallback(async () => {
    const loaded = await loadServices()
    setServices(loaded.rows)
    return loaded
  }, [loadServices])

  useEffect(() => {
    let active = true
    let timer = null
    const run = async () => {
	      try {
	        const loaded = await loadServices()
	        if (active) {
	          pollMsRef.current = loaded.pollMs
	          setServices(loaded.rows)
	          timer = setTimeout(run, loaded.pollMs)
	        }
	      } catch (error) {
	        if (active) toast.error(`System status failed: ${error.message}`)
	        if (active && Number.isFinite(pollMsRef.current) && pollMsRef.current > 0) {
	          timer = setTimeout(run, pollMsRef.current)
	        }
	      }
	    }
    run()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [loadServices])

  const execute = useCallback(async (action, label) => {
    if (!action || busyAction) return
    setBusyAction(action)
    try {
      const result = await flokiAdapter.control(action)
      if (result?.ok === true && result?.verified === true) toast.success(result.message || `${label} verified`)
      else toast.error(`${label} failed${result?.error ? `: ${result.error}` : ''}`)
      await refresh()
    } catch (error) {
      toast.error(`${label} failed: ${error.message}`)
    } finally {
      setBusyAction(null)
    }
  }, [busyAction, refresh])

  const handleRestart = useCallback((service) => {
    execute(service.controlAction, `Restart ${service.name}`)
  }, [execute])

  const handleViewLogs = useCallback(async (service) => {
    try {
      const result = await flokiAdapter.openLog(service.logKey || service.name)
      if (result?.ok) toast.success(`Opened ${service.name} log`)
      else toast.error(`No log available for ${service.name}`)
    } catch (error) {
      toast.error(`Could not open ${service.name} log: ${error.message}`)
    }
  }, [])

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">System Status</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {services.map((service) => (
            <ServiceCard
              key={service.name}
              service={service}
              onRestart={handleRestart}
              onViewLogs={handleViewLogs}
            />
          ))}
        </div>
        <SystemControls onAction={(action) => execute(action, action)} busyAction={busyAction} />

        <div className="rounded-lg border border-border/60 bg-card/50 p-4" data-testid="rsi-module-card">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <FlaskConical className="w-4 h-4 text-neon-cyan flex-none" />
              <div>
                <div className="text-sm font-semibold">Recursive Self-Improvement</div>
                {services.length > 0 && (() => {
                  const rsi = services.find((s) => s.name === 'Recursive Self-Improvement');
                  return rsi ? (
                    <div className="text-xs text-muted-foreground mt-0.5">{rsi.detail || 'Self-improvement service'}</div>
                  ) : null;
                })()}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate?.('rsi_lab')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-neon-cyan/30 bg-neon-cyan/5 hover:bg-neon-cyan/10 text-neon-cyan transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Open RSI Lab
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
