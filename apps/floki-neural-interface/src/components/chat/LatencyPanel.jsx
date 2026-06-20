import React, { useState } from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronUp, Clock } from 'lucide-react'
import flokiAdapter from '@/integrations/floki/adapter'

const healthColors = { Healthy: 'text-neon-green', Slow: 'text-neon-amber', Critical: 'text-neon-red' }

function LatencyRow({ label, ms }) {
  const value = Math.round(Number(ms || 0))
  const health = flokiAdapter.getLatencyHealth(value)
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className={cn('text-[10px] font-mono font-medium', healthColors[health])}>{value}ms</span>
        <span className={cn('w-1.5 h-1.5 rounded-full', { 'bg-neon-green': health === 'Healthy', 'bg-neon-amber': health === 'Slow', 'bg-neon-red': health === 'Critical' })} />
      </div>
    </div>
  )
}

export default function LatencyPanel({ latency }) {
  const [expanded, setExpanded] = useState(false)
  if (!latency) return null
  const total = Math.round(Number(latency.totalResponseTime || 0))
  const health = flokiAdapter.getLatencyHealth(total)
  return (
    <div className="mx-4 mb-2">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors font-mono">
        <Clock className="w-3 h-3" /><span>Total: {total}ms</span><span className={cn('font-medium', healthColors[health])}>({health})</span>{expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {expanded && (
        <div className="mt-1.5 p-2.5 rounded-md bg-background/60 border border-border/30 max-w-xs">
          <LatencyRow label="Transcription" ms={latency.transcriptionTime} />
          <LatencyRow label="Memory Context" ms={latency.memoryContextTime} />
          <LatencyRow label="Vision Context" ms={latency.visionContextTime} />
          <LatencyRow label="Cognition" ms={latency.cognitionTime} />
          <LatencyRow label="First Token" ms={latency.timeToFirstToken} />
          <LatencyRow label="Generation" ms={latency.totalGenerationTime} />
          <LatencyRow label="Text-to-Speech" ms={latency.textToSpeechTime} />
          <div className="border-t border-border/30 mt-1 pt-1"><LatencyRow label="Total Response" ms={latency.totalResponseTime} /></div>
        </div>
      )}
    </div>
  )
}
