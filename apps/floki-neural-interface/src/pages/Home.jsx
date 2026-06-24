import React, { useEffect, useState, useRef } from 'react';
import NavRail from '@/components/shared/NavRail';
import ChatInterface from '@/pages/ChatInterface';
import DreamsDashboard from '@/pages/DreamsDashboard';
import NeuralStream from '@/pages/NeuralStream';
import SystemDashboard from '@/pages/SystemDashboard';
import SettingsPage from '@/pages/SettingsPage';
import flokiAdapter from '@/integrations/floki/adapter';
import { toast } from 'sonner';

const TABS = { chat: ChatInterface, dreams: DreamsDashboard, neural: NeuralStream, system: SystemDashboard, settings: SettingsPage };

const initialState = { connected: false, state: 'Connecting', mode: 'chat.local', online: false, visionActive: false, hearingActive: false, memoryLoaded: false, speechActive: false, sleepState: 'Unknown', cognitionModel: null };

export default function Home() {
  const [activeTab, setActiveTab] = useState('chat');
  const [flokiStatus, setFlokiStatus] = useState(initialState);
  const [error, setError] = useState(null);

  const pendingAlerted = useRef(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const status = await flokiAdapter.getInitialStatus();
        const selfImprovementPending = Number(status.runtime?.self_improvement?.pending_review_count || 0);
        const selfImprovementCandidateId = status.runtime?.self_improvement?.latest_candidate_id || null;
        if (!active) return;
        setFlokiStatus({
          selfImprovementPending,
          selfImprovementCandidateId,
          connected: status.connected !== false,
          state: status.state || 'Idle',
          mode: status.mode || 'chat.local',
          online: status.online === true,
          visionActive: status.visionActive === true,
          hearingActive: status.hearingActive === true,
          memoryLoaded: status.memoryLoaded === true,
          speechActive: status.speechActive === true,
          sleepState: status.sleepState || 'Unknown',
          cognitionModel: status.cognitionModel,
        });
        if (
          selfImprovementPending > 0 &&
          selfImprovementCandidateId &&
          pendingAlerted.current !== selfImprovementCandidateId
        ) {
          pendingAlerted.current = selfImprovementCandidateId;
          toast.warning('Floki has a verified self-improvement upgrade ready for your review. Open System to approve or deny it.');
        }
        setError(null);
      } catch (err) {
        if (!active) return;
        setFlokiStatus((prev) => ({ ...prev, connected: false, state: 'Error' }));
        setError(err.message);
      }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const Active = TABS[activeTab] || ChatInterface;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <NavRail activeTab={activeTab} onTabChange={setActiveTab} flokiStatus={flokiStatus} />
      <main className="flex-1 min-w-0 overflow-hidden">
        <React.Suspense fallback={
          <div className="h-full flex items-center justify-center">
            <div className="w-6 h-6 rounded-full border-2 border-neon-cyan/30 border-t-neon-cyan animate-spin" />
          </div>
        }>
          <Active key={activeTab} flokiStatus={flokiStatus} onNavigate={setActiveTab} />
        </React.Suspense>
      </main>
    </div>
  );
}
