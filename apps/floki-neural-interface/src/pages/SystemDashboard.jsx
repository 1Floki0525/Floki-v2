import React, { useCallback, useEffect, useState } from 'react';
import flokiAdapter from '@/integrations/floki/adapter';
import ServiceCard from '@/components/system/ServiceCard';
import SystemControls from '@/components/system/SystemControls';
import { toast } from 'sonner';

export default function SystemDashboard() {
  const [services, setServices] = useState([]);
  const refresh = useCallback(async () => setServices(await flokiAdapter.getSystemStatus()), []);
  useEffect(() => { refresh().catch(error => toast.error(error.message)); const timer = setInterval(() => refresh().catch(console.error), 3000); return () => clearInterval(timer); }, [refresh]);
  const handleRestart = useCallback(async (name) => { const map = { 'Chat Vision': 'restartVision', 'Webcam Eyes': 'restartVision', 'Speech Listener': 'restartSpeech', 'Cognition Runtime': 'restartChat' }; const result = await flokiAdapter.control(map[name] || 'restartChat'); result.ok ? toast.success(`${name} restarted`) : toast.error(`${name} restart failed`); await refresh(); }, [refresh]);
  const handleViewLogs = useCallback(async (name) => { const result = await flokiAdapter.openLog(name); result.ok ? toast.success(`Opened ${name} log`) : toast.error(`No log found for ${name}`); }, []);
  const handleAction = useCallback(async (action) => { try { const result = await flokiAdapter.control(action); result.ok ? toast.success(`${action} completed`) : toast.error(`${action} failed`); await refresh(); } catch (error) { toast.error(error.message); } }, [refresh]);
  return <div className="h-full overflow-y-auto"><div className="p-6 max-w-6xl mx-auto space-y-6"><h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">System Status</h2><div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">{services.map(service => <ServiceCard key={service.name} service={service} onRestart={handleRestart} onViewLogs={handleViewLogs} />)}</div><SystemControls onAction={handleAction} /></div></div>;
}
