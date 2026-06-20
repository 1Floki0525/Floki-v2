import React, { useEffect, useState } from 'react';
import NeonPanel from '@/components/shared/NeonPanel';
import flokiAdapter from '@/integrations/floki/adapter';

export default function SleepStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => { let active = true; const refresh = async () => { try { const next = await flokiAdapter.getSleepStatus(); if (active) setStatus(next); } catch (error) { console.error(error); } }; refresh(); const timer = setInterval(refresh, 2000); return () => { active = false; clearInterval(timer); }; }, []);
  return <NeonPanel title="Lifecycle"><div className="grid grid-cols-2 gap-2 text-[11px] font-mono"><span className="text-muted-foreground">State</span><span>{status?.state || 'Unknown'}</span><span className="text-muted-foreground">Alertness</span><span>{Math.round(Number(status?.alertness || 0)*100)}%</span><span className="text-muted-foreground">Sleep pressure</span><span>{Math.round(Number(status?.sleepPressure || 0)*100)}%</span><span className="text-muted-foreground">REM</span><span>{status?.remActive ? `Cycle ${status.currentRemCycle || ''}` : 'Inactive'}</span><span className="text-muted-foreground">Eyes</span><span>{status?.externalEyesActive ? 'Active' : 'Offline'}</span></div></NeonPanel>;
}
