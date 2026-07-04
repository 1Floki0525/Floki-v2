import React, { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Mic, MicOff, Send, Square } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'

function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

function flattenAudio(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const samples = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    samples.set(chunk, offset)
    offset += chunk.length
  }
  return samples
}

export default function MessageComposer({ onSend, onInterrupt, onVoiceAudio, onVoiceError, isFlokiResponding }) {
  const [text, setText] = useState('')
  const [isRecording, setIsRecording] = useState(false)
  const textareaRef = useRef(null)
  const recordingRef = useRef(null)

  useEffect(() => {
    if (!textareaRef.current) return
    textareaRef.current.style.height = 'auto'
    textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
  }, [text])

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend()
    }
  }

  const stopRecording = async () => {
    const recorder = recordingRef.current
    recordingRef.current = null
    setIsRecording(false)
    if (!recorder) return
    clearTimeout(recorder.timer)
    try { recorder.processor.disconnect() } catch (_error) {}
    try { recorder.source.disconnect() } catch (_error) {}
    for (const track of recorder.stream.getTracks()) track.stop()
    await recorder.context.close().catch(() => undefined)
    const samples = flattenAudio(recorder.chunks)
    if (samples.length === 0) throw new Error('No microphone samples were captured')
    onVoiceAudio?.(encodeWav(samples, recorder.context.sampleRate))
  }

  const startRecording = async () => {
    if (isFlokiResponding || isRecording) return
    if (!navigator.mediaDevices?.getUserMedia) {
      onVoiceError?.(new Error('Browser microphone capture is unavailable'))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      const AudioContext = window.AudioContext || window.webkitAudioContext
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const chunks = []
      processor.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(context.destination)
      const timer = setTimeout(() => {
        stopRecording().catch((error) => onVoiceError?.(error))
      }, 15000)
      recordingRef.current = { context, source, processor, stream, chunks, timer }
      setIsRecording(true)
    } catch (error) {
      setIsRecording(false)
      onVoiceError?.(error)
    }
  }

  const handleVoice = () => {
    if (isRecording) {
      stopRecording().catch((error) => onVoiceError?.(error))
      return
    }
    startRecording().catch((error) => onVoiceError?.(error))
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="border-t border-border/50 bg-background/80 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 py-3">
          <div className="flex items-end gap-2 bg-secondary/30 border border-border/50 rounded-xl px-3 py-2 focus-within:border-neon-cyan/30 transition-colors">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleKeyDown}
              data-testid="chat-input"
              placeholder="Message Floki..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none min-h-[36px] max-h-[120px] py-1.5"
              rows={1}
              aria-label="Message input"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleVoice}
                  disabled={isFlokiResponding && !isRecording}
                  className={cn('p-2 rounded-lg transition-all flex-shrink-0', isRecording ? 'bg-neon-red/15 border border-neon-red/30 text-neon-red hover:bg-neon-red/25' : 'bg-secondary/30 border border-border/30 text-muted-foreground hover:text-neon-cyan hover:border-neon-cyan/30')}
                  aria-label={isRecording ? 'Stop voice recording' : 'Record voice message'}
                >
                  {isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{isRecording ? 'Stop and send voice' : 'Record voice for host Whisper'}</TooltipContent>
            </Tooltip>
            {isFlokiResponding ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={onInterrupt} className="p-2 rounded-lg bg-neon-red/15 border border-neon-red/30 text-neon-red hover:bg-neon-red/25 transition-colors flex-shrink-0" aria-label="Stop response">
                    <Square className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Interrupt the active Floki response</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleSend}
                    disabled={!text.trim()}
                    data-testid="send-btn"
                    className={cn('p-2 rounded-lg transition-all flex-shrink-0', text.trim() ? 'bg-neon-cyan/15 border border-neon-cyan/30 text-neon-cyan hover:bg-neon-cyan/25' : 'bg-secondary/30 border border-border/30 text-muted-foreground/40')}
                    aria-label="Send message"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Send through Floki's real Chat Mode brain</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
