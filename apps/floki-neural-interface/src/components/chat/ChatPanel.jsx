import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowDown, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { FlokiState, createChatMessage, MessageType } from '@/integrations/floki/types'
import flokiAdapter from '@/integrations/floki/adapter'
import ChatMessage from './ChatMessage'
import LatencyPanel from './LatencyPanel'
import FlokiStateIndicator from './FlokiStateIndicator'
import MessageComposer from './MessageComposer'
import EmptyChat from './EmptyChat'

function transcriptMessage(entry) {
  return createChatMessage({
    id: entry.id,
    role: entry.role,
    content: entry.content,
    type: entry.type === MessageType.SPOKEN ? MessageType.SPOKEN : MessageType.TYPED,
    timestamp: entry.timestamp,
    isStreaming: false,
  })
}

function transcriptIdentity(message) {
  return [message.role, message.type, String(message.content || '').trim()].join('\n')
}

export default function ChatPanel({ flokiStatus }) {
  const [messages, setMessages] = useState([])
  const [flokiState, setFlokiState] = useState(FlokiState.IDLE)
  const [isResponding, setIsResponding] = useState(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const scrollRef = useRef(null)
  const abortRef = useRef(null)

  const scrollToBottom = useCallback((behavior = 'smooth') => {
    if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior })
  }, [])

  useEffect(() => { scrollToBottom('instant') }, [messages.length, scrollToBottom])

  const syncTranscript = useCallback(async () => {
    const transcript = await flokiAdapter.getTranscript(500)
    if (!Array.isArray(transcript)) return

    const authoritative = transcript.map(transcriptMessage)
    const authoritativeIdentities = new Set(authoritative.map(transcriptIdentity))

    setMessages((previous) => {
      const pending = previous.filter((message) =>
        message.isStreaming === true ||
        (message.optimistic === true && !authoritativeIdentities.has(transcriptIdentity(message)))
      )
      const authoritativeIds = new Set(authoritative.map((message) => message.id))
      const uniquePending = pending.filter((message) => !authoritativeIds.has(message.id))
      return [...authoritative, ...uniquePending].sort(
        (left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0)
      )
    })
  }, [])

  useEffect(() => {
    let active = true

    const poll = async () => {
      try {
        if (active) await syncTranscript()
      } catch (error) {
        console.error('authoritative transcript sync failed', error)
      }
    }

    poll()
    const timer = setInterval(poll, 750)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [syncTranscript])

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

    const userMsg = {
      ...createChatMessage({ role: 'user', content: text, type: MessageType.TYPED }),
      optimistic: true,
    }
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
          setMessages((previous) => previous.map((message) =>
            message.id === flokiMsgId
              ? { ...message, content: `Error: ${error.message}`, isStreaming: false }
              : message
          ))
          setIsResponding(false)
          setFlokiState(FlokiState.ERROR)
          abortRef.current = null
        },
        onComplete: (content, latency) => {
          setMessages((previous) => previous.map((message) =>
            message.id === flokiMsgId
              ? { ...message, content, latency, isStreaming: false, optimistic: true }
              : message
          ))
        },
      })
      await syncTranscript()
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
  }, [isResponding, syncTranscript])

  const handleRegenerate = useCallback((assistantMessage) => { const index = messages.findIndex((message) => message.id === assistantMessage.id); for (let cursor = index - 1; cursor >= 0; cursor -= 1) { if (messages[cursor].role === 'user' && String(messages[cursor].content || '').trim()) { void handleSend(messages[cursor].content); return; } } toast.error('No preceding user message is available to regenerate.'); }, [handleSend, messages]);

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

  const handleClearTranscript = useCallback(async () => {
    if (isResponding) {
      toast.warning('Interrupt the active response before clearing the visible chat.')
      return
    }
    const confirmed = window.confirm(
      'Clear the visible chat transcript? This does not delete Floki’s memories, personality, private thoughts, beliefs, relationships, or dreams.'
    )
    if (!confirmed) return

    setIsClearing(true)
    try {
      const result = await flokiAdapter.clearTranscript()
      if (!result?.ok) throw new Error(result?.error || 'Could not clear the visible chat transcript')
      setMessages([])
      toast.success(`Visible chat cleared (${Number(result.entries_cleared || 0)} entries).`)
    } catch (error) {
      toast.error(error.message)
    } finally {
      setIsClearing(false)
    }
  }, [isResponding])

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border/30 bg-background/50 flex items-center justify-between gap-3 pr-3">
        <FlokiStateIndicator state={flokiState} />
        <button
          type="button"
          onClick={handleClearTranscript}
          disabled={isClearing || isResponding || messages.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border border-border/50 bg-secondary/30 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Clear visible chat transcript"
          title="Clear visible chat only; persistent memories are preserved"
        >
          <Trash2 className="w-3.5 h-3.5" />
          {isClearing ? 'Clearing…' : 'Clear chat'}
        </button>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto relative">
        {messages.length === 0 ? (
          <EmptyChat flokiStatus={flokiStatus} />
        ) : (
          <div className="py-4">
            {messages.map((message) => (
              <React.Fragment key={message.id}>
                <ChatMessage message={message} onRegenerate={message.role === 'assistant' ? handleRegenerate : undefined} />
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
