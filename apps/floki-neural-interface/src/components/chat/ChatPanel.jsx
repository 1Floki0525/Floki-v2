import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowDown } from 'lucide-react'
import { toast } from 'sonner'
import { FlokiState, createChatMessage, MessageType } from '@/integrations/floki/types'
import flokiAdapter from '@/integrations/floki/adapter'
import ChatMessage from './ChatMessage'
import LatencyPanel from './LatencyPanel'
import FlokiStateIndicator from './FlokiStateIndicator'
import MessageComposer from './MessageComposer'
import EmptyChat from './EmptyChat'

export default function ChatPanel() {
  const [messages, setMessages] = useState([])
  const [flokiState, setFlokiState] = useState(FlokiState.IDLE)
  const [isResponding, setIsResponding] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const scrollRef = useRef(null)
  const abortRef = useRef(null)

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior })
  }, [])

  useEffect(() => { scrollToBottom('instant') }, [messages.length, scrollToBottom])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setShowScrollBtn(scrollHeight - scrollTop - clientHeight > 100)
  }, [])

  const handleSend = useCallback(async (text) => {
    if (isResponding) {
      toast.warning('Floki is already responding. Interrupt the active response first.')
      return
    }
    const userMsg = createChatMessage({ role: 'user', content: text, type: MessageType.TYPED })
    const flokiMsgId = crypto.randomUUID()
    setMessages((previous) => [
      ...previous,
      userMsg,
      createChatMessage({ id: flokiMsgId, role: 'assistant', content: '', isStreaming: true }),
    ])
    setIsResponding(true)
    const controller = new AbortController()
    abortRef.current = controller

    try {
      await flokiAdapter.sendChatMessage({
        text,
        signal: controller.signal,
        onStateChange: setFlokiState,
        onToken: (content) => {
          setMessages((previous) => previous.map((message) =>
            message.id === flokiMsgId ? { ...message, content } : message
          ))
        },
        onLatency: (latency) => {
          setMessages((previous) => previous.map((message) =>
            message.id === flokiMsgId ? { ...message, latency } : message
          ))
        },
        onError: (error) => {
        setMessages(prev => prev.map(m => m.id === flokiMsgId ? { ...m, content: `Error: ${error.message}`, isStreaming: false } : m));
        setIsResponding(false);
        setFlokiState(FlokiState.ERROR);
        abortRef.current = null;
      },
      onComplete: (content, latency) => {
          setMessages((previous) => previous.map((message) =>
            message.id === flokiMsgId
              ? { ...message, content, latency, isStreaming: false }
              : message
          ))
        },
      })
    } catch (error) {
      if (error?.name !== 'AbortError') {
        toast.error(error.message)
        setMessages((previous) => previous.map((message) =>
          message.id === flokiMsgId
            ? { ...message, content: `Floki local interface error: ${error.message}`, isStreaming: false }
            : message
        ))
      }
    } finally {
      setIsResponding(false)
      setFlokiState(FlokiState.IDLE)
      abortRef.current = null
    }
  }, [isResponding])

  const handleInterrupt = useCallback(() => {
    if (abortRef.current) abortRef.current.abort()
    flokiAdapter.interruptResponse().catch(() => {})
    abortRef.current = null
    setIsResponding(false)
    setFlokiState(FlokiState.IDLE)
    setMessages((previous) => previous.map((message) =>
      message.isStreaming
        ? { ...message, isStreaming: false, content: `${message.content} [interrupted]`.trim() }
        : message
    ))
  }, [])

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border/30 bg-background/50">
        <FlokiStateIndicator state={flokiState} />
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto relative">
        {messages.length === 0 ? (
          <EmptyChat />
        ) : (
          <div className="py-4">
            {messages.map((message) => (
              <React.Fragment key={message.id}>
                <ChatMessage message={message} />
                {message.role === 'assistant' && !message.isStreaming && message.latency && (
                  <LatencyPanel latency={message.latency} />
                )}
              </React.Fragment>
            ))}
          </div>
        )}
        {showScrollBtn && (
          <button
            onClick={() => scrollToBottom()}
            className="absolute bottom-4 right-4 p-2 rounded-full bg-secondary/80 border border-border/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-all shadow-lg"
            aria-label="Jump to newest message"
          >
            <ArrowDown className="w-4 h-4" />
          </button>
        )}
      </div>
      <MessageComposer onSend={handleSend} onInterrupt={handleInterrupt} isFlokiResponding={isResponding} />
    </div>
  )
}
