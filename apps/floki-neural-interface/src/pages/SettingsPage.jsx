import React, { useRef } from 'react'
import { Download, Upload, RotateCw } from 'lucide-react'
import useSettings from '@/hooks/useSettings'
import {
  clearStoredSettings,
  exportSettings,
  importSettings,
  resetAllSettings,
  resetSection,
} from '@/stores/settingsStore'
import SettingsSection from '@/components/settings/SettingsSection'
import SettingRow from '@/components/settings/SettingRow'
import flokiAdapter from '@/integrations/floki/adapter'
import { toast } from 'sonner'

export default function SettingsPage() {
  const [connection, updateConnection] = useSettings('connection')
  const [chat, updateChat] = useSettings('chat')
  const [voice, updateVoice] = useSettings('voice')
  const [vision, updateVision] = useSettings('vision')
  const [emotions, updateEmotions] = useSettings('emotions')
  const [neuralStream, updateNeuralStream] = useSettings('neuralStream')
  const [appearance, updateAppearance] = useSettings('appearance')
  const [latency, updateLatency] = useSettings('latency')
  const [privacy, updatePrivacy] = useSettings('privacy')
  const fileRef = useRef(null)

  const handleExport = () => {
    if (!privacy.allowLocalExport) {
      toast.error('Local export is disabled in Privacy settings')
      return
    }
    const blob = new Blob([exportSettings()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'floki-chat-local-settings.json'
    anchor.click()
    URL.revokeObjectURL(url)
    toast.success('Interface settings exported')
  }

  const handleImport = (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (loadEvent) => {
      try {
        importSettings(loadEvent.target.result)
        toast.success('Interface settings imported')
      } catch (error) {
        toast.error(`Settings import failed: ${error.message}`)
      }
    }
    reader.readAsText(file)
    event.target.value = ''
  }

  const testConnection = async () => {
    try {
      const status = await flokiAdapter.getInitialStatus()
      toast.success(status?.marker || 'Native Electron IPC bridge connected')
    } catch (error) {
      toast.error(`Native Floki bridge failed: ${error.message}`)
    }
  }

  const clearPreferences = () => {
    clearStoredSettings()
    toast.success('Stored interface preferences cleared')
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-neon-cyan/90 font-mono">Settings</h2>
            <p className="mt-1 text-[10px] font-mono text-muted-foreground/60">
              The full interface settings surface is preserved. Native chat.local uses context-isolated Electron IPC; optional REST/WebSocket values remain available for compatibility and future remote wiring.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={handleExport} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-mono bg-secondary/40 text-muted-foreground hover:text-foreground border border-border/30 transition-colors">
              <Download className="w-3 h-3" /> Export
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-mono bg-secondary/40 text-muted-foreground hover:text-foreground border border-border/30 transition-colors">
              <Upload className="w-3 h-3" /> Import
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImport} />
            <button type="button" onClick={() => { resetAllSettings(); toast.success('All interface settings reset') }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-mono bg-neon-red/10 text-neon-red border border-neon-red/20 hover:bg-neon-red/20 transition-colors">
              <RotateCw className="w-3 h-3" /> Reset All
            </button>
          </div>
        </div>

        <SettingsSection title="Connection" onReset={() => resetSection('connection')}>
          <SettingRow label="Transport" type="text" value="Electron IPC" readOnly description="Active chat.local transport. Context isolation remains enabled." />
          <SettingRow label="Local API URL" type="text" value={connection.localApiUrl} onChange={(value) => updateConnection({ localApiUrl: value })} description="Stored compatibility endpoint; native chat.local does not silently replace IPC with HTTP." />
          <SettingRow label="Local WebSocket URL" type="text" value={connection.localWsUrl} onChange={(value) => updateConnection({ localWsUrl: value })} description="Stored compatibility endpoint for future remote event transport." />
          <SettingRow label="Test Connection" type="button" buttonLabel="Test Native Bridge" onChange={testConnection} />
          <SettingRow label="Automatic Reconnect" type="toggle" value={connection.autoReconnect} onChange={(value) => updateConnection({ autoReconnect: value })} />
          <SettingRow label="Reconnect Delay (ms)" type="number" value={connection.reconnectDelay} onChange={(value) => updateConnection({ reconnectDelay: value })} min={1000} max={30000} step={1000} />
          <SettingRow label="Request Timeout (ms)" type="number" value={connection.requestTimeout} onChange={(value) => updateConnection({ requestTimeout: value })} min={5000} max={300000} step={5000} />
          <SettingRow label="Mock Mode" type="toggle" value={connection.mockMode} onChange={(value) => updateConnection({ mockMode: value })} description="Explicit UI test mode only. It is off by default and never presented as live Floki data." />
        </SettingsSection>

        <SettingsSection title="Chat" onReset={() => resetSection('chat')}>
          <SettingRow label="Stream Responses" type="toggle" value={chat.streamResponses} onChange={(value) => updateChat({ streamResponses: value })} />
          <SettingRow label="Show Timestamps" type="toggle" value={chat.showTimestamps} onChange={(value) => updateChat({ showTimestamps: value })} />
          <SettingRow label="Markdown Rendering" type="toggle" value={chat.markdownRendering} onChange={(value) => updateChat({ markdownRendering: value })} />
          <SettingRow label="Compact Messages" type="toggle" value={chat.compactMessages} onChange={(value) => updateChat({ compactMessages: value })} />
          <SettingRow label="Enter to Send" type="toggle" value={chat.enterToSend} onChange={(value) => updateChat({ enterToSend: value })} />
          <SettingRow label="Max Local History" type="number" value={chat.maxLocalHistory} onChange={(value) => updateChat({ maxLocalHistory: value })} min={50} max={5000} step={50} />
        </SettingsSection>

        <SettingsSection title="Voice" onReset={() => resetSection('voice')}>
          <SettingRow label="Microphone Enabled" type="toggle" value={voice.microphoneEnabled} onChange={(value) => updateVoice({ microphoneEnabled: value })} />
          <SettingRow label="Speaker Enabled" type="toggle" value={voice.speakerEnabled} onChange={(value) => updateVoice({ speakerEnabled: value })} />
          <SettingRow label="Hands-Free Listening" type="toggle" value={voice.handsFreeListening} onChange={(value) => updateVoice({ handsFreeListening: value })} />
          <SettingRow label="Push to Talk" type="toggle" value={voice.pushToTalk} onChange={(value) => updateVoice({ pushToTalk: value })} />
          <SettingRow label="Wake Word Enabled" type="toggle" value={voice.wakeWordEnabled} onChange={(value) => updateVoice({ wakeWordEnabled: value })} />
          <SettingRow label="Wake Phrase" type="text" value={voice.wakePhrase} onChange={(value) => updateVoice({ wakePhrase: value })} />
          <SettingRow label="Speech Volume" type="slider" value={voice.speechVolume} onChange={(value) => updateVoice({ speechVolume: value })} min={0} max={100} />
          <SettingRow label="Speech Rate" type="slider" value={Math.round(voice.speechRate * 100)} onChange={(value) => updateVoice({ speechRate: value / 100 })} min={50} max={200} />
          <SettingRow label="Interruptible Speech" type="toggle" value={voice.interruptibleSpeech} onChange={(value) => updateVoice({ interruptibleSpeech: value })} />
          <SettingRow label="Show Partial Transcription" type="toggle" value={voice.showPartialTranscription} onChange={(value) => updateVoice({ showPartialTranscription: value })} />
        </SettingsSection>

        <SettingsSection title="Vision" onReset={() => resetSection('vision')}>
          <SettingRow label="Show Object Boxes" type="toggle" value={vision.showObjectBoxes} onChange={(value) => updateVision({ showObjectBoxes: value })} />
          <SettingRow label="Show Person Boxes" type="toggle" value={vision.showPersonBoxes} onChange={(value) => updateVision({ showPersonBoxes: value })} />
          <SettingRow label="Show Face Boxes" type="toggle" value={vision.showFaceBoxes} onChange={(value) => updateVision({ showFaceBoxes: value })} description="Only applies when a real face detector supplies face boxes." />
          <SettingRow label="Show Recognized Names" type="toggle" value={vision.showRecognizedNames} onChange={(value) => updateVision({ showRecognizedNames: value })} description="Never enables identity recognition by itself; it only controls display of already-authorized names." />
          <SettingRow label="Show Labels" type="toggle" value={vision.showLabels} onChange={(value) => updateVision({ showLabels: value })} />
          <SettingRow label="Show Confidence" type="toggle" value={vision.showConfidence} onChange={(value) => updateVision({ showConfidence: value })} />
          <SettingRow label="Show Scene Recognition" type="toggle" value={vision.showSceneRecognition} onChange={(value) => updateVision({ showSceneRecognition: value })} />
          <SettingRow label="Freshness Threshold (s)" type="number" value={vision.observationFreshnessThreshold} onChange={(value) => updateVision({ observationFreshnessThreshold: value })} min={5} max={120} />
          <SettingRow label="Stale Observation Warning" type="toggle" value={vision.staleObservationWarning} onChange={(value) => updateVision({ staleObservationWarning: value })} />
          <SettingRow label="Privacy Blackout Default" type="toggle" value={vision.privacyBlackoutDefault} onChange={(value) => updateVision({ privacyBlackoutDefault: value })} />
        </SettingsSection>

        <SettingsSection title="Emotions" onReset={() => resetSection('emotions')}>
          <SettingRow label="Graph Time Range" type="select" value={emotions.graphTimeRange} onChange={(value) => updateEmotions({ graphTimeRange: value })} options={[
            { value: '1m', label: '1 Minute' },
            { value: '5m', label: '5 Minutes' },
            { value: '15m', label: '15 Minutes' },
            { value: 'session', label: 'Session' },
          ]} />
          <SettingRow label="Update Frequency (ms)" type="number" value={emotions.updateFrequency} onChange={(value) => updateEmotions({ updateFrequency: value })} min={500} max={10000} step={500} />
          <SettingRow label="Graph Smoothing" type="slider" value={Math.round(emotions.graphSmoothing * 100)} onChange={(value) => updateEmotions({ graphSmoothing: value / 100 })} min={0} max={100} />
        </SettingsSection>

        <SettingsSection title="Neural Stream" onReset={() => resetSection('neuralStream')}>
          <SettingRow label="Auto Scroll" type="toggle" value={neuralStream.autoScroll} onChange={(value) => updateNeuralStream({ autoScroll: value })} />
          <SettingRow label="Maximum Events" type="number" value={neuralStream.maxEvents} onChange={(value) => updateNeuralStream({ maxEvents: value })} min={100} max={10000} step={100} />
          <SettingRow label="Compact View" type="toggle" value={neuralStream.compactView} onChange={(value) => updateNeuralStream({ compactView: value })} />
        </SettingsSection>

        <SettingsSection title="Appearance" onReset={() => resetSection('appearance')}>
          <SettingRow label="Neon Intensity" type="slider" value={appearance.neonIntensity} onChange={(value) => updateAppearance({ neonIntensity: value })} min={0} max={100} />
          <SettingRow label="Glow Intensity" type="slider" value={appearance.glowIntensity} onChange={(value) => updateAppearance({ glowIntensity: value })} min={0} max={100} />
          <SettingRow label="Animation Level" type="select" value={appearance.animationLevel} onChange={(value) => updateAppearance({ animationLevel: value })} options={[
            { value: 'none', label: 'None' },
            { value: 'reduced', label: 'Reduced' },
            { value: 'normal', label: 'Normal' },
            { value: 'full', label: 'Full' },
          ]} />
          <SettingRow label="Font Size" type="number" value={appearance.fontSize} onChange={(value) => updateAppearance({ fontSize: value })} min={10} max={24} />
          <SettingRow label="Interface Scale (%)" type="slider" value={appearance.interfaceScale} onChange={(value) => updateAppearance({ interfaceScale: value })} min={75} max={150} />
          <SettingRow label="Panel Density" type="select" value={appearance.panelDensity} onChange={(value) => updateAppearance({ panelDensity: value })} options={[
            { value: 'compact', label: 'Compact' },
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'spacious', label: 'Spacious' },
          ]} />
          <SettingRow label="Reduced Motion" type="toggle" value={appearance.reducedMotion} onChange={(value) => updateAppearance({ reducedMotion: value })} />
        </SettingsSection>

        <SettingsSection title="Latency" onReset={() => resetSection('latency')}>
          <SettingRow label="First Token Target (ms)" type="number" value={latency.firstTokenTarget} onChange={(value) => updateLatency({ firstTokenTarget: value })} min={100} max={5000} />
          <SettingRow label="First Spoken Audio Target (ms)" type="number" value={latency.firstSpokenAudioTarget} onChange={(value) => updateLatency({ firstSpokenAudioTarget: value })} min={500} max={10000} />
          <SettingRow label="Slow Warning Threshold (ms)" type="number" value={latency.slowWarningThreshold} onChange={(value) => updateLatency({ slowWarningThreshold: value })} min={500} max={10000} />
          <SettingRow label="Critical Threshold (ms)" type="number" value={latency.criticalThreshold} onChange={(value) => updateLatency({ criticalThreshold: value })} min={1000} max={30000} />
          <SettingRow label="Show Detailed Stage Timing" type="toggle" value={latency.showDetailedStageTiming} onChange={(value) => updateLatency({ showDetailedStageTiming: value })} />
        </SettingsSection>

        <SettingsSection title="Privacy" onReset={() => resetSection('privacy')}>
          <SettingRow label="Hide Vision by Default" type="toggle" value={privacy.hideVisionByDefault} onChange={(value) => updatePrivacy({ hideVisionByDefault: value })} />
          <SettingRow label="Hide Recognized Names" type="toggle" value={privacy.hideRecognizedNames} onChange={(value) => updatePrivacy({ hideRecognizedNames: value })} />
          <SettingRow label="Redact Private Metadata" type="toggle" value={privacy.redactPrivateMetadata} onChange={(value) => updatePrivacy({ redactPrivateMetadata: value })} />
          <SettingRow label="Allow Local Export" type="toggle" value={privacy.allowLocalExport} onChange={(value) => updatePrivacy({ allowLocalExport: value })} />
          <SettingRow label="Clear Stored Preferences" type="button" buttonLabel="Clear" onChange={clearPreferences} description="Clears all locally stored UI preferences and restores defaults." />
        </SettingsSection>
      </div>
    </div>
  )
}
