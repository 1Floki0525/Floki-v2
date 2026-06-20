import React from 'react'
import { cn } from '@/lib/utils'
import { Pause, Play, Eye, Ear, Volume2, StopCircle } from 'lucide-react'

const controls = [
  { id: 'pauseSleep', label: 'Pause Auto Sleep', icon: Pause, color: 'cyan' },
  { id: 'resumeSleep', label: 'Resume Auto Sleep', icon: Play, color: 'green' },
  { id: 'restartVision', label: 'Restart Vision', icon: Eye, color: 'cyan' },
  { id: 'restartHearing', label: 'Restart Hearing', icon: Ear, color: 'cyan' },
  { id: 'restartSpeech', label: 'Restart Speech Loop', icon: Volume2, color: 'cyan' },
  { id: 'interrupt', label: 'Interrupt Response', icon: StopCircle, color: 'red' },
]

const colorMap = {
  green: 'bg-neon-green/10 border-neon-green/20 text-neon-green hover:bg-neon-green/20',
  red: 'bg-neon-red/10 border-neon-red/20 text-neon-red hover:bg-neon-red/20',
  cyan: 'bg-neon-cyan/10 border-neon-cyan/20 text-neon-cyan hover:bg-neon-cyan/20',
}

export default function SystemControls({ onAction }) {
  return (
    <div className="glass-panel rounded-lg p-4">
      <h3 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono mb-3">Real Runtime Controls</h3>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
        {controls.map((control) => {
          const Icon = control.icon
          return (
            <button key={control.id} onClick={() => onAction(control.id)} className={cn('flex items-center gap-2 px-3 py-2 rounded-md border text-xs font-mono transition-all', colorMap[control.color])}>
              <Icon className="w-3.5 h-3.5" />
              {control.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
