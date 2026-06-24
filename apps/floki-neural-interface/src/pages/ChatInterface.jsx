import React from 'react';
import ChatPanel from '@/components/chat/ChatPanel';
import VisionPanel from '@/components/vision/VisionPanel';
import ObservationCard from '@/components/vision/ObservationCard';
import EmotionGraph from '@/components/emotions/EmotionGraph';
import SleepStatus from '@/components/sleep/SleepStatus';
import { ShieldCheck } from 'lucide-react';

export default function ChatInterface({ flokiStatus, onNavigate }) {
  return (
    <div className="flex h-full overflow-hidden">
      {Number(flokiStatus?.selfImprovementPending || 0) > 0 && (
        <div
          data-testid="self-improvement-chat-alert"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[min(760px,calc(100vw-2rem))] rounded-lg border border-orange-500/50 bg-background/95 shadow-2xl backdrop-blur px-4 py-3 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-start gap-3 min-w-0">
            <ShieldCheck className="w-5 h-5 text-orange-300 flex-none mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-orange-200">Upgrade ready for review</div>
              <p className="text-xs text-muted-foreground mt-1">
                Floki has completed and verified a recursive self-improvement candidate. Nothing enters the active runtime until you approve it.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate?.('system')}
            className="px-3 py-2 rounded-md border border-orange-400/40 bg-orange-400/10 text-orange-100 hover:bg-orange-400/20 text-xs font-semibold"
          >
            Review upgrade
          </button>
        </div>
      )}

      {/* Left — Chat (60%) */}
      <div className="flex-[3] min-w-0 border-r border-border/30">
        <ChatPanel flokiStatus={flokiStatus} />
      </div>

      {/* Right — Live View (40%) */}
      <div className="flex-[2] min-w-0 overflow-y-auto">
        <div className="p-4 space-y-4">
          <VisionPanel />
          <ObservationCard />
          <EmotionGraph />
          <SleepStatus />
        </div>
      </div>
    </div>
  );
}