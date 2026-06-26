import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Beaker,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CirclePause,
  CirclePlay,
  Code2,
  ExternalLink,
  FileText,
  FlaskConical,
  RefreshCw,
  ShieldCheck,
  XCircle
} from 'lucide-react'
import flokiAdapter from '@/integrations/floki/adapter'
import { toast } from 'sonner'

function stateLabel(value) {
  return String(value || 'unknown').replaceAll('_', ' ')
}

function riskClass(level) {
  if (level === 'critical') return 'text-red-400 border-red-500/30 bg-red-500/10'
  if (level === 'high') return 'text-orange-400 border-orange-500/30 bg-orange-500/10'
  if (level === 'medium') return 'text-yellow-300 border-yellow-500/30 bg-yellow-500/10'
  return 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
}

export default function SelfImprovementPanel() {
  const [status, setStatus] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [expandedDiff, setExpandedDiff] = useState(false)
  const [busy, setBusy] = useState(null)
  const [actionFeedback, setActionFeedback] = useState(null)
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null)
  const [reviewAction, setReviewAction] = useState(null)
  const [denyReason, setDenyReason] = useState('')
  const [makerObjective, setMakerObjective] = useState('')
  const alertedCandidate = useRef(null)
  const pollMsRef = useRef(null)

  const refresh = useCallback(async () => {
    const [nextStatus, nextCandidates] = await Promise.all([
      flokiAdapter.getSelfImprovementStatus(),
      flokiAdapter.getSelfImprovementCandidates()
    ])
    setStatus(nextStatus)
    setLastRefreshedAt(Date.now())
    setCandidates(Array.isArray(nextCandidates) ? nextCandidates : [])
    const pending = (nextCandidates || []).find((candidate) => candidate.status === 'pending_review')
    if (pending && alertedCandidate.current !== pending.id) {
      alertedCandidate.current = pending.id
      toast.warning('Floki has a verified self-improvement candidate ready for your review.')
    }
    if (!selectedId && pending) setSelectedId(pending.id)
    return nextStatus
  }, [selectedId])

  useEffect(() => {
    let active = true
    let timer = null

	    const run = async () => {
	      try {
	        const nextStatus = await refresh()
	        const pollMs = Number(nextStatus?.ui_poll_ms)
	        if (!Number.isFinite(pollMs) || pollMs <= 0) {
	          throw new Error('self_improvement.ui_poll_ms is invalid')
	        }
	        pollMsRef.current = pollMs
	        if (active) timer = setTimeout(run, pollMs)
	      } catch (error) {
	        if (active) toast.error(`Self-improvement status failed: ${error.message}`)
	        if (active && Number.isFinite(pollMsRef.current) && pollMsRef.current > 0) {
	          timer = setTimeout(run, pollMsRef.current)
	        }
	      }
	    }

    run()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  useEffect(() => {
    let active = true
    if (!selectedId) {
      setDetail(null)
      return () => { active = false }
    }
    flokiAdapter.getSelfImprovementCandidate(selectedId)
      .then((candidate) => { if (active) setDetail(candidate) })
      .catch((error) => { if (active) toast.error(`Candidate load failed: ${error.message}`) })
    return () => { active = false }
  }, [selectedId])

  useEffect(() => {
    setReviewAction(null)
    setDenyReason('')
  }, [detail?.id, detail?.status])

  const pending = useMemo(
    () => candidates.filter((candidate) => candidate.status === 'pending_review'),
    [candidates]
  )

  const act = useCallback(async (name, action, verify) => {
    if (busy) return
    setBusy(name)
    setActionFeedback({ ok: null, message: `${name} in progress...` })
    try {
      const result = await action()
      if (result?.ok === false) throw new Error(result.error || `${name} failed`)
      const nextStatus = await refresh()
      const verifiedStatus = result?.status || nextStatus
      if (verify && verify(verifiedStatus, result) !== true) {
        throw new Error(`${name} verification failed`)
      }
      const message = result?.message || `${name} completed and verified`
      setActionFeedback({ ok: true, message })
      toast.success(message)
      if (selectedId) {
        setDetail(await flokiAdapter.getSelfImprovementCandidate(selectedId))
      }
    } catch (error) {
      const message = `${name} failed: ${error.message}`
      setActionFeedback({ ok: false, message })
      toast.error(message)
    } finally {
      setBusy(null)
    }
  }, [busy, refresh, selectedId])

  const manualRefresh = useCallback(async () => {
    if (busy) return
    setBusy('Refresh status')
    setActionFeedback({ ok: null, message: 'Refreshing self-improvement status...' })
    try {
      await refresh()
      setActionFeedback({ ok: true, message: 'Self-improvement status refreshed and verified.' })
      toast.success('Self-improvement status refreshed')
    } catch (error) {
      const message = `Refresh status failed: ${error.message}`
      setActionFeedback({ ok: false, message })
      toast.error(message)
    } finally {
      setBusy(null)
    }
  }, [busy, refresh])

  const openLog = useCallback(async (key, label) => {
    try {
      const result = await flokiAdapter.openLog(key)
      if (!result?.ok) throw new Error(`${label} is not available`)
      toast.success(`Opened ${label}`)
    } catch (error) {
      toast.error(`Could not open ${label}: ${error.message}`)
    }
  }, [])

  const requestApprove = useCallback(() => {
    if (!detail || detail.status !== 'pending_review') return
    setReviewAction('approve')
  }, [detail])

  const confirmApprove = useCallback(() => {
    if (!detail || detail.status !== 'pending_review') return
    setReviewAction(null)
    act('Approve candidate', () => flokiAdapter.approveSelfImprovement(detail.id))
  }, [act, detail])

  const requestDeny = useCallback(() => {
    if (!detail || detail.status !== 'pending_review') return
    setReviewAction('deny')
  }, [detail])

  const confirmDeny = useCallback(() => {
    if (!detail || detail.status !== 'pending_review') return
    const reason = denyReason
    setReviewAction(null)
    act('Deny candidate', () => flokiAdapter.denySelfImprovement(detail.id, reason))
  }, [act, denyReason, detail])

  const cancelReviewAction = useCallback(() => {
    setReviewAction(null)
    setDenyReason('')
  }, [])

  return (
    <section className="rounded-lg border border-neon-cyan/20 bg-card/70 overflow-hidden" data-testid="self-improvement-panel">
      <div className="p-5 border-b border-border/50 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-neon-cyan" />
            <h3 className="text-sm font-semibold tracking-wide">Recursive Self-Improvement</h3>
            {pending.length > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-orange-500/15 border border-orange-500/30 text-orange-300">
                {pending.length} REVIEW
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Writable isolated development environment with shell, current web research, MCP, verification, and Maker-only promotion.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="w-full max-w-sm space-y-1">
            <label
              htmlFor="maker-objective"
              className="text-[10px] font-mono text-muted-foreground tracking-wide"
            >
              Experiment objective — optional
            </label>
            <textarea
              id="maker-objective"
              value={makerObjective}
              onChange={(e) => setMakerObjective(e.target.value)}
              disabled={
                Boolean(busy) ||
                pending.length > 0 ||
                status?.worker_running !== true ||
                status?.model_proxy_ready !== true ||
                status?.paused === true ||
                Boolean(status?.current_run_id) ||
                status?.phase === 'maker_requested_cycle' ||
                ['queued', 'starting', 'researching', 'experimenting', 'verifying'].includes(status?.state)
              }
              rows={2}
              placeholder="Leave empty for Floki to inspect himself and choose an experiment. Enter an objective to require Floki to conduct that experiment."
              className="w-full rounded-md border border-border bg-background/80 px-3 py-2 text-[11px] text-foreground outline-none focus:border-neon-cyan/50 resize-none disabled:opacity-40 placeholder:text-muted-foreground/50"
            />
          </div>
          <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openLog('Self-Improvement Worker', 'self-improvement worker log')}
            className="px-3 py-2 text-xs rounded-md border border-border hover:border-neon-cyan/40 flex items-center gap-2"
          >
            <FileText className="w-4 h-4" />
            Worker log
          </button>
          <button
            type="button"
            onClick={() => openLog('Self-Improvement Sandbox', 'latest self-improvement sandbox log')}
            className="px-3 py-2 text-xs rounded-md border border-border hover:border-neon-cyan/40 disabled:opacity-50 flex items-center gap-2"
          >
            <FileText className="w-4 h-4" />
            Sandbox log
          </button>
          <button
            onClick={() => status?.paused
              ? act(
                  'Resume worker',
                  () => flokiAdapter.resumeSelfImprovement(),
                  (nextStatus) => {
                    if (nextStatus?.paused === false) return true
                    throw new Error('Resume verification failed')
                  }
                )
              : act(
                  'Pause worker',
                  () => flokiAdapter.pauseSelfImprovement(),
                  (nextStatus) => {
                    if (nextStatus?.paused === true) return true
                    throw new Error('Pause verification failed')
                  }
                )}
            disabled={Boolean(busy) || !status}
            className="px-3 py-2 text-xs rounded-md border border-border hover:border-neon-cyan/40 disabled:opacity-50 flex items-center gap-2"
          >
            {status?.paused ? <CirclePlay className="w-4 h-4" /> : <CirclePause className="w-4 h-4" />}
            {status?.paused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={() => {
              const trimmedObjective = makerObjective.trim()
              act(
                'Run improvement cycle',
                () => flokiAdapter.runSelfImprovementNow(trimmedObjective),
                (nextStatus, result) => {
                  if (
                    result?.ok === true &&
                    result?.verified === true &&
                    result?.wake_signal_sent === true &&
                    result?.bypass_idle_timer === true &&
                    result?.sandbox_started === true &&
                    result?.marker ===
                      'FLOKI_V2_SELF_IMPROVEMENT_RUN_NOW_IMMEDIATE' &&
                    typeof nextStatus?.current_run_id === 'string' &&
                    nextStatus.current_run_id.length > 0 &&
                    typeof nextStatus?.current_container === 'string' &&
                    nextStatus.current_container.length > 0 &&
                    ['experimenting', 'verifying'].includes(nextStatus?.state)
                  ) {
                    setMakerObjective('')
                    return true
                  }
                  throw new Error(
                    'Run now did not start the sandbox immediately'
                  )
                }
              )
            }}
            disabled={
              Boolean(busy) ||
              pending.length > 0 ||
              status?.worker_running !== true ||
              status?.model_proxy_ready !== true ||
              status?.paused === true ||
              Boolean(status?.current_run_id) ||
              status?.phase === 'maker_requested_cycle' ||
              [
                'queued',
                'starting',
                'researching',
                'experimenting',
                'verifying'
              ].includes(status?.state)
            }
            className="px-3 py-2 text-xs rounded-md border border-neon-cyan/30 bg-neon-cyan/10 hover:bg-neon-cyan/15 disabled:opacity-50 flex items-center gap-2"
          >
            <Beaker className="w-4 h-4" />
            Run now
          </button>
          <button
            onClick={manualRefresh}
            disabled={Boolean(busy)}
            className="p-2 rounded-md border border-border hover:border-neon-cyan/40 disabled:opacity-50"
            aria-label="Refresh self-improvement status"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          </div>
        </div>
      </div>

      <div className="px-5 pt-4 flex flex-wrap items-center justify-between gap-3">
        {actionFeedback ? (
          <div className={`text-xs rounded border px-3 py-2 ${
            actionFeedback.ok === true
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : actionFeedback.ok === false
                ? 'border-red-500/30 bg-red-500/10 text-red-300'
                : 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan'
          }`}>
            {actionFeedback.message}
          </div>
        ) : <span />}
        <span className="text-[10px] font-mono text-muted-foreground">
          {lastRefreshedAt ? `Last refreshed ${new Date(lastRefreshedAt).toLocaleTimeString()}` : 'Not refreshed yet'}
        </span>
      </div>

      <div className="p-5 grid grid-cols-1 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.8fr)] gap-5">
        <div className="space-y-4">
          <div className="rounded-md border border-border/60 p-4 space-y-2 text-xs">
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">State</span><span className="font-mono capitalize">{stateLabel(status?.state)}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Phase</span><span className="font-mono text-right capitalize">{stateLabel(status?.phase)}</span></div>
            {status?.objective_source && (
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Cycle type</span>
                <span className={`font-mono text-right ${status.objective_source === 'maker_requested' ? 'text-neon-cyan' : 'text-emerald-400'}`}>
                  {status.objective_source === 'maker_requested' ? 'Maker-requested' : 'Floki-selected'}
                </span>
              </div>
            )}
            {status?.requested_objective && (
              <div className="flex justify-between gap-3 mt-1">
                <span className="text-muted-foreground flex-none">Objective</span>
                <span className="font-mono text-right text-[10px] truncate max-w-[16rem]" title={status.requested_objective}>{status.requested_objective}</span>
              </div>
            )}
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Worker</span><span className={status?.worker_running ? 'text-emerald-400' : 'text-red-400'}>{status?.worker_running ? 'Running' : 'Stopped'}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Sandbox</span><span className="font-mono truncate max-w-[16rem]">{status?.current_container || 'None'}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Last heartbeat</span><span className="font-mono">{status?.last_heartbeat_at ? new Date(status.last_heartbeat_at).toLocaleTimeString() : 'None'}</span></div>
            {status?.last_error && (
              <div className="mt-3 p-3 rounded border border-red-500/30 bg-red-500/10 text-red-300 whitespace-pre-wrap break-words">
                {status.last_error}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h4 className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground font-mono">Candidates</h4>
            {candidates.length === 0 && (
              <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-4">
                No candidate has been produced yet.
              </div>
            )}
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                onClick={() => setSelectedId(candidate.id)}
                className={`w-full text-left rounded-md border p-3 transition-colors ${
                  selectedId === candidate.id ? 'border-neon-cyan/50 bg-neon-cyan/5' : 'border-border/60 hover:border-border'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono truncate">{candidate.id}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{stateLabel(candidate.status)}</span>
                </div>
                <p className="text-xs mt-2 line-clamp-2">{candidate.objective}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0">
          {!detail ? (
            <div className="h-full min-h-72 rounded-md border border-dashed border-border flex items-center justify-center text-sm text-muted-foreground">
              Select a candidate to review its evidence and exact patch.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-md border border-border/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold">{detail.objective}</h4>
                    <p className="text-xs text-muted-foreground font-mono mt-1">{detail.id}</p>
                  </div>
                  <span className={`px-2 py-1 rounded border text-[10px] uppercase ${riskClass(detail.risk_level)}`}>
                    {detail.risk_level} risk
                  </span>
                </div>
                <p className="text-sm mt-4 whitespace-pre-wrap">{detail.summary_markdown}</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-md border border-border/60 p-3">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 mb-2" />
                  <div className="text-xs font-semibold">Verification</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {detail.test_results?.filter((row) => row.ok).length || 0}/{detail.test_results?.length || 0} passed
                  </div>
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <Code2 className="w-4 h-4 text-neon-cyan mb-2" />
                  <div className="text-xs font-semibold">Changed files</div>
                  <div className="text-xs text-muted-foreground mt-1">{detail.changed_files?.length || 0}</div>
                </div>
                <div className="rounded-md border border-border/60 p-3">
                  <ExternalLink className="w-4 h-4 text-violet-400 mb-2" />
                  <div className="text-xs font-semibold">Current sources</div>
                  <div className="text-xs text-muted-foreground mt-1">{detail.research_sources?.length || 0}</div>
                </div>
              </div>

              <div className="rounded-md border border-border/60 overflow-hidden">
                <button
                  onClick={() => setExpandedDiff((value) => !value)}
                  className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold hover:bg-secondary/30"
                >
                  Exact candidate patch
                  {expandedDiff ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                {expandedDiff && (
                  <pre className="max-h-[34rem] overflow-auto p-4 text-[11px] leading-5 bg-black/30 border-t border-border/60 whitespace-pre">
                    {detail.diff}
                  </pre>
                )}
              </div>

              <div className="rounded-md border border-border/60 p-4">
                <h5 className="text-xs font-semibold mb-2">Risk assessment</h5>
                <p className="text-xs text-muted-foreground whitespace-pre-wrap">{detail.risk_notes}</p>
              </div>

              {detail.status === 'pending_review' && (
                <div className="space-y-3 pt-2">
                  {reviewAction === 'deny' && (
                    <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 space-y-3">
                      <label className="block text-xs font-semibold text-red-200" htmlFor="self-improvement-deny-reason">
                        Denial reason
                      </label>
                      <textarea
                        id="self-improvement-deny-reason"
                        value={denyReason}
                        onChange={(event) => setDenyReason(event.target.value)}
                        rows={3}
                        className="w-full rounded-md border border-red-500/30 bg-background/80 px-3 py-2 text-sm text-foreground outline-none focus:border-red-300"
                        placeholder="Optional note for Floki's future RSI cycles"
                      />
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          onClick={cancelReviewAction}
                          disabled={Boolean(busy)}
                          className="px-3 py-2 rounded-md border border-border text-xs hover:border-red-300 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={confirmDeny}
                          disabled={Boolean(busy)}
                          className="px-3 py-2 rounded-md border border-red-500/30 bg-red-500/15 text-red-200 hover:bg-red-500/20 disabled:opacity-50 flex items-center gap-2 text-xs"
                        >
                          <XCircle className="w-4 h-4" />
                          Confirm deny
                        </button>
                      </div>
                    </div>
                  )}

                  {reviewAction === 'approve' && (
                    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4 space-y-3 text-sm">
                      <p className="text-emerald-100">
                        Approving {detail.id} will stop chat.local, apply the exact verified patch, run the full release gate, roll back automatically on failure, and reopen the interface.
                      </p>
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          onClick={cancelReviewAction}
                          disabled={Boolean(busy)}
                          className="px-3 py-2 rounded-md border border-border text-xs hover:border-emerald-300 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={confirmApprove}
                          disabled={Boolean(busy)}
                          className="px-3 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50 flex items-center gap-2 text-xs"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          Confirm approve
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap justify-end gap-3">
                    <button
                      type="button"
                      onClick={requestDeny}
                      disabled={Boolean(busy)}
                      className="px-4 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/15 disabled:opacity-50 flex items-center gap-2 text-sm"
                    >
                      <XCircle className="w-4 h-4" />
                      Deny
                    </button>
                    <button
                      type="button"
                      onClick={requestApprove}
                      disabled={Boolean(busy)}
                      className="px-4 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15 disabled:opacity-50 flex items-center gap-2 text-sm"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      Approve and activate
                    </button>
                  </div>
                </div>
              )}

              {detail.status === 'promotion_failed' && (
                <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300 flex gap-3">
                  <AlertTriangle className="w-5 h-5 flex-none" />
                  <span>{detail.failure || 'Promotion failed. The active runtime was not left on an unverified candidate.'}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
