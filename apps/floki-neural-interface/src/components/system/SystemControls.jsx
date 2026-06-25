import React from 'react'
import { cn } from '@/lib/utils'
import {
  Ear,
  Eye,
  Moon,
  Pause,
  Play,
  RotateCw,
  Square,
  StopCircle,
  Sun,
  Volume2,
} from 'lucide-react'

export const SYSTEM_CONTROLS = [
  { id: 'startChat', label: 'Start Chat Mode', icon: Play, color: 'green' },
  { id: 'stopChat', label: 'Stop Chat Mode', icon: Square, color: 'red' },
  { id: 'restartChat', label: 'Restart Chat Mode', icon: RotateCw, color: 'cyan' },
  { id: 'wake', label: 'Wake Floki', icon: Sun, color: 'amber' },
  { id: 'requestSleep', label: 'Request Configured Nap', icon: Moon, color: 'blue' },
  { id: 'pauseSleep', label: 'Pause Nightly Scheduler', icon: Pause, color: 'cyan' },
  { id: 'resumeSleep', label: 'Resume Nightly Scheduler', icon: Play, color: 'cyan' },
  { id: 'restartVision', label: 'Restart Vision', icon: Eye, color: 'cyan' },
  { id: 'restartHearing', label: 'Restart Hearing', icon: Ear, color: 'cyan' },
  { id: 'restartSpeech', label: 'Restart Speech', icon: Volume2, color: 'cyan' },
  { id: 'interrupt', label: 'Interrupt Response', icon: StopCircle, color: 'red' },
]

const colorMap = {
  green: 'bg-neon-green/10 border-neon-green/20 text-neon-green hover:bg-neon-green/20',
  red: 'bg-neon-red/10 border-neon-red/20 text-neon-red hover:bg-neon-red/20',
  cyan: 'bg-neon-cyan/10 border-neon-cyan/20 text-neon-cyan hover:bg-neon-cyan/20',
  amber: 'bg-neon-amber/10 border-neon-amber/20 text-neon-amber hover:bg-neon-amber/20',
  blue: 'bg-neon-blue/10 border-neon-blue/20 text-neon-blue hover:bg-neon-blue/20',
}

export default function SystemControls({ onAction, busyAction = null }) {
  return (
    <div className="glass-panel rounded-lg p-4">
      <h3 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono mb-3">
        System Controls
      </h3>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
        {SYSTEM_CONTROLS.map((control) => {
          const Icon = control.icon
          const busy = busyAction === control.id
          return (
            <button
              type="button"
              key={control.id}
              data-testid={`system-control-${control.id}`}
              aria-busy={busy}
              disabled={busyAction !== null}
              onClick={() => onAction(control.id)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-md border text-xs font-mono transition-all disabled:opacity-40 disabled:cursor-wait',
                colorMap[control.color]
              )}
            >
              <Icon className={cn('w-3.5 h-3.5', busy && 'animate-spin')} />
              {busy ? `${control.label}...` : control.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
