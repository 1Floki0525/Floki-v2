import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const DEFAULT_SCROLLBACK_LINES = 5000
const DEFAULT_AT_BOTTOM_THRESHOLD_PX = 32

// Read-only xterm renderer over the raw PTY byte transport. The parent owns
// polling, cursors, the bounded replay window, and the Follow Output header
// control; this component owns the xterm lifecycle, fitting, follow tracking,
// and disposal. Raw bytes are written to xterm untouched so ANSI colours,
// cursor movement, carriage-return updates, backspaces, and prompts render
// exactly as the PTY produced them — xterm's fitted columns control wrapping,
// never ordinary HTML text flow.
//
// Write model: `revision` identifies one replay window generation. When it
// changes (bootstrap, source switch, cursor discontinuity, Load Older) the
// terminal is reset and every chunk is replayed; otherwise only chunks whose
// end cursor advances past the last written byte are appended. Tracking the
// written end cursor per revision also makes React Strict Mode re-runs and
// rerenders write each byte exactly once per mounted terminal. Writes issued
// before Terminal.open() are buffered by xterm and flush once it opens.
/**
 * @typedef {Object} ReadOnlyXtermTerminalProps
 * @property {number} revision
 * @property {string} revisionKind
 * @property {Array<{ start: number, end: number, bytes: Uint8Array }>} chunks
 * @property {boolean} hasSource
 * @property {number} [scrollbackLines]
 * @property {number} [atBottomThresholdPx]
 * @property {(following: boolean) => void} [onFollowingChange]
 */
const ReadOnlyXtermTerminal = forwardRef(
  /**
   * @param {ReadOnlyXtermTerminalProps} props
   * @param {React.ForwardedRef<{ followOutput: () => void }>} ref
   */
  function ReadOnlyXtermTerminal({
    revision,
    revisionKind,
    chunks,
    hasSource,
    scrollbackLines,
    atBottomThresholdPx,
    onFollowingChange
  }, ref) {
  const containerRef = useRef(null)
  const sessionRef = useRef(null)
  const writtenRef = useRef({ revision: null, end: null })
  const followRef = useRef(true)
  const fitFrameRef = useRef(null)
  const thresholdRef = useRef(DEFAULT_AT_BOTTOM_THRESHOLD_PX)
  const onFollowingChangeRef = useRef(onFollowingChange)
  const copyNoticeTimerRef = useRef(null)
  const [copyNotice, setCopyNotice] = useState('')

  const scrollback = Number.isFinite(Number(scrollbackLines)) && Number(scrollbackLines) > 0
    ? Number(scrollbackLines)
    : DEFAULT_SCROLLBACK_LINES
  const threshold = Number.isFinite(Number(atBottomThresholdPx)) && Number(atBottomThresholdPx) > 0
    ? Number(atBottomThresholdPx)
    : DEFAULT_AT_BOTTOM_THRESHOLD_PX

  useEffect(() => {
    thresholdRef.current = threshold
  }, [threshold])

  useEffect(() => {
    onFollowingChangeRef.current = onFollowingChange
  }, [onFollowingChange])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return undefined
    let disposed = false
    const term = new Terminal({
      disableStdin: true,
      convertEol: false,
      cursorBlink: false,
      scrollback: DEFAULT_SCROLLBACK_LINES,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: {
        background: '#0a0f0d',
        foreground: '#a7f3d0',
        cursor: '#a7f3d0',
        selectionBackground: '#134e4a'
      }
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    const session = { term, fitAddon, opened: false, viewport: null }
    sessionRef.current = session

    const reportCopy = (message) => {
      setCopyNotice(message)
      if (copyNoticeTimerRef.current) clearTimeout(copyNoticeTimerRef.current)
      copyNoticeTimerRef.current = setTimeout(() => {
        copyNoticeTimerRef.current = null
        setCopyNotice('')
      }, 1600)
    }

    const copySelection = async () => {
      if (!term.hasSelection()) return false
      const selected = term.getSelection()
      if (!selected) return false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(selected)
        } else {
          const textarea = document.createElement('textarea')
          textarea.value = selected
          textarea.setAttribute('readonly', '')
          textarea.style.position = 'fixed'
          textarea.style.opacity = '0'
          document.body.appendChild(textarea)
          textarea.select()
          const copied = document.execCommand('copy')
          textarea.remove()
          if (!copied) throw new Error('clipboard copy command was rejected')
        }
        reportCopy('Copied selection')
        return true
      } catch (error) {
        reportCopy('Copy failed')
        console.error('RSI terminal copy failed', error)
        return false
      }
    }

    term.attachCustomKeyEventHandler((event) => {
      const copyShortcut =
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        String(event.key || '').toLowerCase() === 'c'
      if (copyShortcut && term.hasSelection()) {
        void copySelection()
        return false
      }
      return true
    })

    const handleContextMenu = (event) => {
      if (!term.hasSelection()) return
      event.preventDefault()
      void copySelection()
    }
    node.addEventListener('contextmenu', handleContextMenu)
    const scheduleFit = () => {
      if (fitFrameRef.current) cancelAnimationFrame(fitFrameRef.current)
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null
        if (disposed || !session.opened) return
        try {
          fitAddon.fit()
        } catch {
          // The host can be zero-sized mid-layout; the next resize refits.
        }
      })
    }
    const setFollowing = (nearBottom) => {
      followRef.current = nearBottom
      if (typeof onFollowingChangeRef.current === 'function') {
        onFollowingChangeRef.current(nearBottom)
      }
    }
    const handleScroll = () => {
      const viewport = session.viewport
      if (!viewport) return
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      // Follow only while the user is already near the bottom; scrolling
      // upward pauses bottom-follow instead of fighting the user.
      setFollowing(distance <= thresholdRef.current)
    }
    // Open only once the host is mounted with measurable nonzero dimensions
    // so xterm never sizes itself against a collapsed container.
    const openWhenSized = () => {
      if (disposed || session.opened) return
      if (node.clientWidth <= 0 || node.clientHeight <= 0) return
      term.open(node)
      session.opened = true
      try {
        fitAddon.fit()
      } catch {
        // Refitted on the next resize tick.
      }
      const viewport = node.querySelector('.xterm-viewport')
      session.viewport = viewport
      if (viewport) viewport.addEventListener('scroll', handleScroll)
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(scheduleFit).catch(() => {})
      }
      if (followRef.current) term.scrollToBottom()
    }
    const observer = new ResizeObserver(() => {
      openWhenSized()
      scheduleFit()
    })
    observer.observe(node)
    openWhenSized()
    writtenRef.current = { revision: null, end: null }
    setFollowing(true)
    return () => {
      disposed = true
      sessionRef.current = null
      if (session.viewport) session.viewport.removeEventListener('scroll', handleScroll)
      node.removeEventListener('contextmenu', handleContextMenu)
      observer.disconnect()
      if (copyNoticeTimerRef.current) {
        clearTimeout(copyNoticeTimerRef.current)
        copyNoticeTimerRef.current = null
      }
      if (fitFrameRef.current) {
        cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      fitAddon.dispose()
      term.dispose()
    }
  }, [])

  useEffect(() => {
    const session = sessionRef.current
    if (session) session.term.options.scrollback = scrollback
  }, [scrollback])

  useEffect(() => {
    const session = sessionRef.current
    if (!session) return
    const list = Array.isArray(chunks) ? chunks : []
    const pinToBottom = () => {
      if (sessionRef.current === session && session.opened && followRef.current) {
        session.term.scrollToBottom()
      }
    }
    if (writtenRef.current.revision !== revision) {
      session.term.reset()
      writtenRef.current = { revision, end: null }
      // A Load Older replay keeps the reader on the earlier history instead
      // of forcing them back to the newest output.
      const settle = revisionKind === 'older'
        ? () => {
            if (sessionRef.current === session && session.opened) {
              session.term.scrollToTop()
            }
          }
        : pinToBottom
      if (revisionKind !== 'older') followRef.current = true
      if (list.length === 0) {
        settle()
        return
      }
      list.forEach((chunk, index) => {
        const isLast = index === list.length - 1
        session.term.write(chunk.bytes, isLast ? settle : undefined)
        writtenRef.current = { revision, end: chunk.end }
      })
      return
    }
    const pending = list.filter((chunk) => {
      const written = writtenRef.current
      return written.end === null || chunk.end > written.end
    })
    pending.forEach((chunk, index) => {
      const isLast = index === pending.length - 1
      session.term.write(chunk.bytes, isLast ? pinToBottom : undefined)
      writtenRef.current = { revision, end: chunk.end }
    })
  }, [revision, revisionKind, chunks])

  useImperativeHandle(ref, () => ({
    followOutput() {
      followRef.current = true
      if (typeof onFollowingChangeRef.current === 'function') {
        onFollowingChangeRef.current(true)
      }
      const session = sessionRef.current
      if (session && session.opened) session.term.scrollToBottom()
    }
  }), [])

  const showEmpty = hasSource && (!Array.isArray(chunks) || chunks.length === 0)

  return (
    <div className="absolute inset-0 h-full w-full min-h-0 min-w-0 overflow-hidden">
      <div
        ref={containerRef}
        className="rsi-xterm-host absolute inset-0 h-full w-full min-h-0 min-w-0 overflow-hidden"
        role="log"
        aria-label="Raw read-only RSI terminal output"
      />
      {!hasSource && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="font-mono text-xs text-muted-foreground">
            Waiting for a terminal source…
          </p>
        </div>
      )}
      {showEmpty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="font-mono text-xs text-muted-foreground">
            No raw terminal output is available yet.
          </p>
        </div>
      )}
      {copyNotice && (
        <div
          className="pointer-events-none absolute bottom-2 right-3 rounded border border-emerald-400/40 bg-black/85 px-2 py-1 font-mono text-[10px] text-emerald-200"
          role="status"
          aria-live="polite"
        >
          {copyNotice}
        </div>
      )}
    </div>
  )
  }
)

export default ReadOnlyXtermTerminal
