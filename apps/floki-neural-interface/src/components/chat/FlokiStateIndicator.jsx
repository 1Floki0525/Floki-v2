import React from 'react';
import { cn } from '@/lib/utils';
import { FlokiState } from '@/integrations/floki/types';
import {
  Brain, Ear, Eye, MessageSquare, Volume2, Moon, AlertTriangle,
  Mic, Clock, Search, Loader
} from 'lucide-react';

const stateConfig = {
  [FlokiState.IDLE]: { icon: Clock, color: 'text-neon-cyan/60', label: 'Idle', animate: false },
  [FlokiState.LISTENING]: { icon: Ear, color: 'text-neon-green', label: 'Listening...', animate: true },
  [FlokiState.HEARING_SPEECH]: { icon: Mic, color: 'text-neon-green', label: 'Hearing Speech...', animate: true },
  [FlokiState.TRANSCRIBING]: { icon: MessageSquare, color: 'text-neon-blue', label: 'Transcribing...', animate: true },
  [FlokiState.THINKING]: { icon: Brain, color: 'text-neon-cyan', label: 'Thinking...', animate: true },
  [FlokiState.REMEMBERING]: { icon: Search, color: 'text-neon-cyan', label: 'Remembering...', animate: true },
  [FlokiState.LOOKING]: { icon: Eye, color: 'text-neon-cyan', label: 'Looking...', animate: true },
  [FlokiState.RESPONDING]: { icon: Loader, color: 'text-neon-cyan', label: 'Responding...', animate: true },
  [FlokiState.SPEAKING]: { icon: Volume2, color: 'text-neon-green', label: 'Speaking...', animate: true },
  [FlokiState.SLEEPING]: { icon: Moon, color: 'text-neon-blue', label: 'Sleeping', animate: false },
  [FlokiState.ERROR]: { icon: AlertTriangle, color: 'text-neon-red', label: 'Error', animate: false },
};

export default function FlokiStateIndicator({ state }) {
  const config = stateConfig[state] || stateConfig[FlokiState.IDLE];
  const Icon = config.icon;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <Icon className={cn('w-3.5 h-3.5', config.color, config.animate && 'animate-pulse')} />
      <span className={cn('text-xs font-mono', config.color)}>{config.label}</span>
    </div>
  );
}