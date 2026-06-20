import React, { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Send, Square } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'

export default function MessageComposer({ onSend, onInterrupt, isFlokiResponding }) {
  const [text, setText] = useState('')
  const textareaRef = useRef(null)

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
          <p className="mt-2 px-1 text-[10px] font-mono text-muted-foreground/60">
            Microphone, wake-word hearing, Piper speech, and webcam sight are controlled by the real chat.local services shown in System Status.
          </p>
        </div>
      </div>
    </TooltipProvider>
  )
}
