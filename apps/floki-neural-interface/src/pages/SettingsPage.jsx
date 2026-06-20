import React, { useRef } from 'react'
import { Download, Upload, RotateCw, PlugZap } from 'lucide-react'
import useSettings from '@/hooks/useSettings'
import { resetSection, resetAllSettings, exportSettings, importSettings } from '@/stores/settingsStore'
import SettingsSection from '@/components/settings/SettingsSection'
import SettingRow from '@/components/settings/SettingRow'
import flokiAdapter from '@/integrations/floki/adapter'
import { toast } from 'sonner'

export default function SettingsPage() {
  const [connection, updateConnection] = useSettings('connection')
  const [latency, updateLatency] = useSettings('latency')
  const fileRef = useRef(null)

  const handleExport = () => {
    const blob = new Blob([exportSettings()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'floki-chat-local-settings.json'
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success('Local interface settings exported')
  }

  const handleImport = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (loadEvent) => {
      try {
        importSettings(loadEvent.target.result)
        toast.success('Local interface settings imported')
      } catch (error) {
        toast.error(`Settings import failed: ${error.message}`)
      }
    }
    reader.readAsText(file)
  }

  const testConnection = async () => {
    try {
      const status = await flokiAdapter.getInitialStatus()
      const marker = status?.marker || 'FLOKI_V2_CHAT_LOCAL_BRIDGE_CONNECTED'
      toast.success(marker)
    } catch (error) {
      toast.error(`Native Floki bridge failed: ${error.message}`)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">Settings</h2>
            <p className="mt-1 text-[10px] font-mono text-muted-foreground/60">
              Interface-only settings live here. Floki&apos;s models, vision, voice, sleep, memory, and runtime authority remain in the Floki-v2 configuration and modules.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={testConnection} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-mono bg-neon-cyan/10 text-neon-cyan border border-neon-cyan/20 hover:bg-neon-cyan/20 transition-colors">
              <PlugZap className="w-3 h-3" /> Test Bridge
            </button>
            <button onClick={handleExport} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-mono bg-secondary/40 text-muted-foreground hover:text-foreground border border-border/30 transition-colors">
              <Download className="w-3 h-3" /> Export
            </button>
            <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-mono bg-secondary/40 text-muted-foreground hover:text-foreground border border-border/30 transition-colors">
              <Upload className="w-3 h-3" /> Import
            </button>
            <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
            <button onClick={() => { resetAllSettings(); toast.success('Local interface settings reset') }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-mono bg-neon-red/10 text-neon-red border border-neon-red/20 hover:bg-neon-red/20 transition-colors">
              <RotateCw className="w-3 h-3" /> Reset
            </button>
          </div>
        </div>

        <SettingsSection title="Native Connection" onReset={() => resetSection('connection')}>
          <SettingRow
            label="Transport"
            description="Context-isolated Electron IPC directly into the local Floki-v2 runtime"
            type="text"
            value="Electron IPC"
            onChange={() => {}}
          />
          <SettingRow
            label="Automatic Reconnect"
            description="Reconnect renderer subscriptions after an Electron renderer reload"
            type="toggle"
            value={connection.autoReconnect}
            onChange={(value) => updateConnection({ autoReconnect: value })}
          />
          <SettingRow
            label="Reconnect Delay (ms)"
            description="Delay before restoring renderer-side subscriptions"
            type="number"
            value={connection.reconnectDelay}
            onChange={(value) => updateConnection({ reconnectDelay: value })}
            min={1000}
            max={30000}
            step={1000}
          />
          <SettingRow
            label="Request Timeout (ms)"
            description="Maximum wait for a native Floki runtime request"
            type="number"
            value={connection.requestTimeout}
            onChange={(value) => updateConnection({ requestTimeout: value })}
            min={5000}
            max={120000}
            step={5000}
          />
        </SettingsSection>

        <SettingsSection title="Latency Display" onReset={() => resetSection('latency')}>
          <SettingRow label="First Token Target (ms)" description="Display target for the first streamed model chunk" type="number" value={latency.firstTokenTarget} onChange={(value) => updateLatency({ firstTokenTarget: value })} min={100} max={5000} step={100} />
          <SettingRow label="First Spoken Audio Target (ms)" description="Display target for first Piper audio" type="number" value={latency.firstSpokenAudioTarget} onChange={(value) => updateLatency({ firstSpokenAudioTarget: value })} min={500} max={10000} step={100} />
          <SettingRow label="Slow Warning Threshold (ms)" description="Responses at or above this time appear slow" type="number" value={latency.slowWarningThreshold} onChange={(value) => updateLatency({ slowWarningThreshold: value })} min={500} max={10000} step={100} />
          <SettingRow label="Critical Threshold (ms)" description="Responses at or above this time appear critical" type="number" value={latency.criticalThreshold} onChange={(value) => updateLatency({ criticalThreshold: value })} min={1000} max={30000} step={100} />
        </SettingsSection>
      </div>
    </div>
  )
}
