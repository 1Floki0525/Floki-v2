import React from 'react';
import ChatPanel from '@/components/chat/ChatPanel';
import VisionPanel from '@/components/vision/VisionPanel';
import ObservationCard from '@/components/vision/ObservationCard';
import EmotionGraph from '@/components/emotions/EmotionGraph';
import SleepStatus from '@/components/sleep/SleepStatus';

export default function ChatInterface() {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Left — Chat (60%) */}
      <div className="flex-[3] min-w-0 border-r border-border/30">
        <ChatPanel />
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