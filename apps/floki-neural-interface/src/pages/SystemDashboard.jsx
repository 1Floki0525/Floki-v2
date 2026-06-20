import React, { useCallback, useEffect, useState } from 'react'
import flokiAdapter from '@/integrations/floki/adapter'
import ServiceCard from '@/components/system/ServiceCard'
import SystemControls from '@/components/system/SystemControls'
import { toast } from 'sonner'

export default function SystemDashboard() {
  const [services, setServices] = useState([])
  const [busyAction, setBusyAction] = useState(null)

  const refresh = useCallback(async () => {
    const next = await flokiAdapter.getSystemStatus()
    setServices(Array.isArray(next) ? next : [])
  }, [])

  useEffect(() => {
    let active = true
    const run = async () => {
      try {
        const next = await flokiAdapter.getSystemStatus()
        if (active) setServices(Array.isArray(next) ? next : [])
      } catch (error) {
        if (active) toast.error(`System status failed: ${error.message}`)
      }
    }
    run()
    const timer = setInterval(run, 3000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  const execute = useCallback(async (action, label) => {
    if (!action || busyAction) return
    setBusyAction(action)
    try {
      const result = await flokiAdapter.control(action)
      if (result?.ok) toast.success(`${label} completed`)
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
      </div>
    </div>
  )
}
