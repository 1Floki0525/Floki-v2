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
  Cpu,
  Database,
  FileText,
  FlaskConical,
  Moon,
  RefreshCw,
  ShieldCheck,
  Square,
  XCircle
} from 'lucide-react'
import flokiAdapter from '@/integrations/floki/adapter'
import { formatTorontoTime } from '@/lib/time'
import { toast } from 'sonner'

const ACTIVE_STATUSES = new Set([
  'pending_review',
  'approved',
  'validating',
  'deploying',
  'promotion_failed',
  'validation_failed',
  'deployment_failed'
])

function label(value) {
  return String(value || 'unknown').replaceAll('_', ' ')
}

function when(value) {
  if (!value) return 'None'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value)
}

function riskClass(level) {
  if (level === 'critical') return 'text-red-300 border-red-500/30 bg-red-500/10'
  if (level === 'high') return 'text-orange-300 border-orange-500/30 bg-orange-500/10'
  if (level === 'medium') return 'text-yellow-200 border-yellow-500/30 bg-yellow-500/10'
  return 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
}

function StatusRow({ name, value, title, accent = '' }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-muted-foreground flex-none">{name}</span>
      <span className={`font-mono text-right break-all ${accent}`} title={title || String(value || '')}>
        {value == null || value === '' ? 'None' : value}
      </span>
    </div>
  )
}

function ProgressBar({ value }) {
  const numeric = Number(value)
  const bounded = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0
  return (
    <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
      <div className="h-full bg-neon-cyan/70" style={{ width: `${bounded}%` }} />
    </div>
  )
}

export default function SelfImprovementPanel() {
  const [status, setStatus] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [expandedEvidence, setExpandedEvidence] = useState(false)
  const [busy, setBusy] = useState(null)
  const [actionFeedback, setActionFeedback] = useState(null)
  const [reviewAction, setReviewAction] = useState(null)
  const [denyReason, setDenyReason] = useState('')
  const [makerObjective, setMakerObjective] = useState('')
  const [candidateView, setCandidateView] = useState('pending')
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null)
  const pollMsRef = useRef(null)

  const refresh = useCallback(async () => {
    const [nextStatus, nextCandidates] = await Promise.all([
      flokiAdapter.getSelfImprovementStatus(),
      flokiAdapter.getSelfImprovementCandidates()
    ])
    setStatus(nextStatus)
    setCandidates(Array.isArray(nextCandidates) ? nextCandidates : [])
    setLastRefreshedAt(Date.now())
    const firstPending = (nextCandidates || []).find((row) => row.status === 'pending_review')
    setSelectedId((current) => current || firstPending?.id || nextCandidates?.[0]?.id || null)
    return nextStatus
  }, [])

  useEffect(() => {
    let active = true
    let timer = null
    const run = async () => {
      try {
        const nextStatus = await refresh()
        const pollMs = Number(nextStatus?.ui_poll_ms)
        if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('self_improvement.ui_poll_ms is invalid')
        pollMsRef.current = pollMs
        if (active) timer = setTimeout(run, pollMs)
      } catch (error) {
        if (active) {
          setActionFeedback({ ok: false, message: `Status refresh failed: ${error.message}` })
          if (Number.isFinite(pollMsRef.current)) timer = setTimeout(run, pollMsRef.current)
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
      .catch((error) => { if (active) setActionFeedback({ ok: false, message: error.message }) })
    return () => { active = false }
  }, [selectedId])

  useEffect(() => {
    setReviewAction(null)
    setDenyReason('')
  }, [detail?.id, detail?.status])

  const activeCandidates = useMemo(
    () => candidates
      .filter((row) => ACTIVE_STATUSES.has(String(row.status || '')))
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))),
    [candidates]
  )
  const historyCandidates = useMemo(
    () => candidates
      .filter((row) => !ACTIVE_STATUSES.has(String(row.status || '')))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
    [candidates]
  )
  const shownCandidates = candidateView === 'history' ? historyCandidates : activeCandidates
  const candidateRenderLimit = Number(status?.ui_limits?.candidate_render_limit)
  const visibleCandidates = Number.isInteger(candidateRenderLimit) && candidateRenderLimit > 0
    ? shownCandidates.slice(0, candidateRenderLimit)
    : []

  const act = useCallback(async (name, operation, verify) => {
    if (busy) return
    setBusy(name)
    setActionFeedback({ ok: null, message: `${name} in progress…` })
    try {
      const result = await operation()
      if (result?.ok === false) throw new Error(result.error || `${name} failed`)
      const nextStatus = await refresh()
      const verifiedStatus = result?.status || nextStatus
      if (verify && verify(verifiedStatus, result) !== true) {
        throw new Error(`${name} verification failed`)
      }
      const message = result?.message || `${name} completed`
      setActionFeedback({ ok: true, message })
      toast.success(message)
      if (selectedId) setDetail(await flokiAdapter.getSelfImprovementCandidate(selectedId))
    } catch (error) {
      const message = `${name} failed: ${error.message}`
      setActionFeedback({ ok: false, message })
      toast.error(message)
    } finally {
      setBusy(null)
    }
  }, [busy, refresh, selectedId])

  const runCode = useCallback(() => {
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
          result?.marker === 'FLOKI_V2_SELF_IMPROVEMENT_RUN_NOW_IMMEDIATE' &&
          typeof nextStatus?.current_run_id === 'string' &&
          nextStatus.current_run_id.length > 0 &&
          typeof nextStatus?.current_container === 'string' &&
          nextStatus.current_container.length > 0 &&
          ['experimenting', 'verifying'].includes(nextStatus?.state)
        ) {
          setMakerObjective('')
          return true
        }
        throw new Error('Run now did not start the sandbox immediately')
      }
    )
  }, [act, makerObjective])

  const runTraining = useCallback(() => {
    const trimmedObjective = makerObjective.trim()
    act(
      'Run training',
      () => flokiAdapter.runSelfImprovementNow(trimmedObjective, 'training'),
      (nextStatus, result) => {
        if (
          result?.ok === true &&
          result?.verified === true &&
          nextStatus?.current_run_kind === 'training' &&
          typeof nextStatus?.current_run_id === 'string' &&
          nextStatus.current_run_id.length > 0
        ) {
          setMakerObjective('')
          return true
        }
        throw new Error('Run training did not start the production training path')
      }
    )
  }, [act, makerObjective])

  const abortSandbox = useCallback(() => {
    act(
      'Abort sandbox',
      () => flokiAdapter.abortSelfImprovement('code'),
      (_next, result) => (
        result?.ok === true &&
        result?.verified === true &&
        result?.stopped === true
      )
    )
  }, [act])

  const abortTraining = useCallback(() => {
    act(
      'Abort training',
      () => flokiAdapter.abortSelfImprovement('training'),
      (_next, result) => (
        result?.ok === true &&
        result?.verified === true &&
        result?.stopped === true
      )
    )
  }, [act])

  const requestApprove = useCallback(() => {
    if (!detail || detail.status !== 'pending_review') return
    setReviewAction('approve')
  }, [detail])

  const confirmApprove = useCallback(() => {
    if (!detail || detail.status !== 'pending_review') return
    setReviewAction(null)
    act(
      'Approve candidate',
      () => flokiAdapter.approveSelfImprovement(detail.id)
    )
  }, [act, detail])

  const requestDeny = useCallback(() => {
    if (!detail || detail.status !== 'pending_review') return
    setReviewAction('deny')
  }, [detail])

  const confirmDeny = useCallback(() => {
    if (!detail || detail.status !== 'pending_review') return
    const reason = denyReason
    setReviewAction(null)
    act(
      'Deny candidate',
      () => flokiAdapter.denySelfImprovement(detail.id, reason)
    )
  }, [act, denyReason, detail])

  const cancelReviewAction = useCallback(() => {
    setReviewAction(null)
    setDenyReason('')
  }, [])

  const canRunCode = status?.controls?.can_run_code === true
  const canRunTraining = status?.controls?.can_run_training === true
  const canAbort = status?.controls?.can_abort === true
  const canStopCode = status?.controls?.can_stop_code === true
  const canAbortTraining = status?.controls?.can_abort_training === true
  const codeSandboxActive = canStopCode || (
    canAbort && status?.current_run_kind === 'code'
  )
  const trainingAbortActive = canAbortTraining || (
    canAbort && status?.current_run_kind === 'training'
  )
  const makerCycleQueued = status?.phase === 'maker_requested_cycle'
  const progress = status?.training_progress || {}
  const progressPercent = Number(progress.percent || progress.progress_percent || 0)
  const nextRem = status?.rem_coordination?.next_rem
  const errors = Array.isArray(status?.surfaced_errors) ? status.surfaced_errors : []
  const isAdapter = detail?.candidate_type === 'model_adapter'

  return (
    <section className="h-full min-h-0 flex flex-col overflow-hidden rounded-lg border border-neon-cyan/20 bg-card/70" data-testid="self-improvement-panel">
      <header className="flex-none px-4 py-3 border-b border-border/50">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="w-5 h-5 text-neon-cyan" />
            <div>
              <h3 className="text-sm font-semibold tracking-wide">Recursive Self-Improvement</h3>
              <p className="text-[10px] text-muted-foreground font-mono">
                Code sandbox + QLoRA training + nightly REM coordination
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => flokiAdapter.openLog('Self-Improvement Worker')} className="px-2.5 py-1.5 text-xs rounded border border-border hover:border-neon-cyan/40 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> Worker log
            </button>
            <button type="button" onClick={() => flokiAdapter.openLog('Self-Improvement Sandbox')} className="px-2.5 py-1.5 text-xs rounded border border-border hover:border-neon-cyan/40 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> Active log
            </button>
            <button
              type="button"
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
              disabled={Boolean(busy) || !status?.controls?.can_pause}
              className="px-2.5 py-1.5 text-xs rounded border border-border hover:border-neon-cyan/40 disabled:opacity-40 flex items-center gap-1.5"
            >
              {status?.paused ? <CirclePlay className="w-3.5 h-3.5" /> : <CirclePause className="w-3.5 h-3.5" />}
              {status?.paused ? 'Resume' : 'Pause'}
            </button>
            {codeSandboxActive && (
              <button type="button" onClick={abortSandbox} disabled={Boolean(busy)} className="px-2.5 py-1.5 text-xs rounded border border-red-500/40 bg-red-500/10 text-red-200 disabled:opacity-40 flex items-center gap-1.5">
                <Square className="w-3.5 h-3.5" /> Abort sandbox
              </button>
            )}
            {trainingAbortActive && (
              <button type="button" onClick={abortTraining} disabled={Boolean(busy)} className="px-2.5 py-1.5 text-xs rounded border border-red-500/40 bg-red-500/10 text-red-200 disabled:opacity-40 flex items-center gap-1.5">
                <Square className="w-3.5 h-3.5" /> Abort training
              </button>
            )}
            <button type="button" onClick={() => act('Refresh status', refresh)} disabled={Boolean(busy)} className="p-1.5 rounded border border-border hover:border-neon-cyan/40 disabled:opacity-40" aria-label="Refresh RSI status">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="mt-3 space-y-1">
          <label htmlFor="maker-objective" className="text-[10px] font-mono text-muted-foreground tracking-wide">
            Experiment objective — optional
          </label>
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_auto] gap-2">
            <textarea
              id="maker-objective"
              value={makerObjective}
              onChange={(event) => setMakerObjective(event.target.value)}
              rows={2}
              disabled={Boolean(busy) || makerCycleQueued || (!canRunCode && !canRunTraining)}
              placeholder="Leave empty for Floki to inspect himself and choose an experiment. Enter an objective to require Floki to conduct that experiment."
              className="w-full resize-none rounded border border-border bg-background/80 px-3 py-2 text-xs outline-none focus:border-neon-cyan/50 disabled:opacity-40"
            />
            <div className="flex items-stretch gap-2">
              <button type="button" onClick={runCode} disabled={Boolean(busy) || makerCycleQueued || !canRunCode} className="px-3 py-2 text-xs rounded border border-neon-cyan/30 bg-neon-cyan/10 disabled:opacity-40 flex items-center gap-2">
                <Code2 className="w-4 h-4" /> Run now
              </button>
              <button type="button" onClick={runTraining} disabled={Boolean(busy) || makerCycleQueued || !canRunTraining} className="px-3 py-2 text-xs rounded border border-violet-500/30 bg-violet-500/10 text-violet-200 disabled:opacity-40 flex items-center gap-2">
                <Cpu className="w-4 h-4" /> Run training
              </button>
            </div>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-3 min-h-7">
          {actionFeedback ? (
            <div className={`text-[11px] rounded border px-2.5 py-1 ${
              actionFeedback.ok === true
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                : actionFeedback.ok === false
                  ? 'border-red-500/30 bg-red-500/10 text-red-200'
                  : 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan'
            }`}>{actionFeedback.message}</div>
          ) : <span />}
          <span className="text-[10px] font-mono text-muted-foreground">
            {lastRefreshedAt ? formatTorontoTime(lastRefreshedAt) : 'Not refreshed'}
          </span>
        </div>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[22rem_minmax(0,1fr)] overflow-hidden">
        <aside className="min-h-0 overflow-y-auto border-r border-border/50 p-3 space-y-3">
          <div className="rounded border border-border/60 p-3 text-[11px]">
            <StatusRow name="Run kind" value={label(status?.active_run_kind)} accent="text-neon-cyan" />
            <StatusRow name="State" value={label(status?.state)} />
            <StatusRow name="Phase" value={label(status?.phase)} />
            <StatusRow
              name="Cycle type"
              value={
                status?.objective_source === 'maker_requested'
                  ? 'Maker-requested'
                  : status?.objective_source
                    ? 'Floki-selected'
                    : 'None'
              }
              accent={status?.objective_source === 'maker_requested' ? 'text-neon-cyan' : 'text-emerald-300'}
            />
            <StatusRow name="Goal" value={status?.current_objective || status?.requested_objective} />
            <StatusRow name="Role" value={label(status?.active_role)} />
            <StatusRow name="Tool" value={status?.active_tool} />
            <StatusRow name="Resource mode" value={label(status?.resource_mode)} />
            <StatusRow name="GPU owner" value={label(status?.gpu_owner)} accent={status?.gpu_owner ? 'text-violet-200' : ''} />
          </div>

          <div className="rounded border border-border/60 p-3 text-[11px] space-y-2">
            <div className="flex items-center gap-2 font-semibold"><Cpu className="w-3.5 h-3.5 text-violet-300" /> Training</div>
            <StatusRow name="HF state" value={label(status?.hf_state?.mode)} />
            <StatusRow name="Session" value={status?.hf_state?.session_run_id} />
            <StatusRow name="Segment" value={status?.hf_state?.segment_number} />
            <StatusRow name="Container" value={status?.hf_state?.current_container} />
            <StatusRow name="Checkpoint" value={status?.hf_state?.latest_checkpoint} />
            <ProgressBar value={progressPercent} />
            <StatusRow name="Progress" value={progressPercent ? `${progressPercent}%` : label(progress.status)} />
          </div>

          <div className="rounded border border-border/60 p-3 text-[11px]">
            <div className="flex items-center gap-2 font-semibold mb-2"><Moon className="w-3.5 h-3.5 text-indigo-300" /> REM coordination</div>
            <StatusRow name="Current REM" value={status?.rem_coordination?.current_cycle} />
            <StatusRow name="Next REM" value={nextRem ? `#${nextRem.cycle_number} · ${when(nextRem.scheduled_at)}` : null} />
            <StatusRow name="Nightly provider" value={status?.providers?.nightly_rem} />
            <StatusRow name="Nap provider" value={status?.providers?.manual_nap_rem} />
            <StatusRow name="Claims complete" value={status?.rem_coordination?.completed_claims} />
            <StatusRow name="Claim failures" value={status?.rem_coordination?.failed_claims} />
          </div>

          <div className="rounded border border-border/60 p-3 text-[11px]">
            <div className="flex items-center gap-2 font-semibold mb-2"><Database className="w-3.5 h-3.5 text-emerald-300" /> Loaded models & lineage</div>
            {(status?.loaded_models || []).length === 0 ? (
              <div className="text-muted-foreground">No GPU model owner reported.</div>
            ) : (status.loaded_models || []).map((row, index) => (
              <div key={`${row.provider}-${index}`} className="mb-2 last:mb-0">
                <StatusRow name={row.provider} value={row.model || row.purpose} />
                <div className="text-[10px] text-muted-foreground">{label(row.purpose)}</div>
              </div>
            ))}
            <StatusRow name="Active adapter" value={status?.lineage?.active_adapter_id || 'HF master'} />
            <StatusRow name="Version" value={status?.lineage?.active_version} />
            <StatusRow name="Rollback" value={status?.lineage?.rollback_target} />
          </div>

          {(errors.length > 0 || status?.restoration) && (
            <div className="rounded border border-red-500/30 bg-red-500/5 p-3 text-[11px]">
              <div className="flex items-center gap-2 font-semibold text-red-200 mb-2"><AlertTriangle className="w-3.5 h-3.5" /> Errors & restoration</div>
              {errors.map((error, index) => <div key={index} className="text-red-200 whitespace-pre-wrap break-words mb-2">{String(error)}</div>)}
              {status?.restoration && <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-muted-foreground">{JSON.stringify(status.restoration, null, 2)}</pre>}
            </div>
          )}
        </aside>

        <main className="min-h-0 grid grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)] overflow-hidden">
          <div className="min-h-0 overflow-y-auto border-r border-border/50 p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h4 className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground font-mono">Candidates</h4>
              <div className="flex rounded border border-border/60 p-0.5">
                <button type="button" onClick={() => setCandidateView('pending')} className={`px-2 py-1 text-[10px] rounded ${candidateView === 'pending' ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-muted-foreground'}`}>Pending {activeCandidates.length}</button>
                <button type="button" onClick={() => setCandidateView('history')} className={`px-2 py-1 text-[10px] rounded ${candidateView === 'history' ? 'bg-neon-cyan/15 text-neon-cyan' : 'text-muted-foreground'}`}>History {historyCandidates.length}</button>
              </div>
            </div>
            <div className="space-y-2">
              {visibleCandidates.map((candidate) => (
                <button key={candidate.id} type="button" onClick={() => setSelectedId(candidate.id)} className={`w-full text-left rounded border p-3 ${selectedId === candidate.id ? 'border-neon-cyan/50 bg-neon-cyan/5' : 'border-border/60 hover:border-border'}`}>
                  <div className="flex justify-between gap-2">
                    <span className="text-[11px] font-mono truncate">{candidate.id}</span>
                    <span className="text-[9px] uppercase text-muted-foreground">{label(candidate.status)}</span>
                  </div>
                  <div className="text-[10px] text-violet-200 mt-1">{label(candidate.candidate_type || 'code_patch')}</div>
                  <p className="text-xs mt-1 line-clamp-3">{candidate.objective}</p>
                </button>
              ))}
              {visibleCandidates.length === 0 && <div className="text-xs text-muted-foreground border border-dashed border-border rounded p-4">No candidates in this view.</div>}
              {shownCandidates.length > visibleCandidates.length && <div className="text-[10px] text-center text-muted-foreground">…{shownCandidates.length - visibleCandidates.length} more</div>}
            </div>
          </div>

          <div className="min-h-0 overflow-y-auto p-4">
            {!detail ? (
              <div className="h-full min-h-48 rounded border border-dashed border-border flex items-center justify-center text-sm text-muted-foreground">Select a candidate.</div>
            ) : (
              <div className="space-y-3">
                <div className="rounded border border-border/60 p-4">
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold">{detail.objective}</h4>
                      <div className="text-[10px] font-mono text-muted-foreground mt-1">{detail.id} · {label(detail.candidate_type || 'code_patch')}</div>
                    </div>
                    <span className={`px-2 py-1 rounded border text-[10px] uppercase ${riskClass(detail.risk_level)}`}>{detail.risk_level || 'unknown'} risk</span>
                  </div>
                  <p className="text-sm mt-3 whitespace-pre-wrap">{detail.summary_markdown}</p>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  <div className="rounded border border-border/60 p-3"><ShieldCheck className="w-4 h-4 text-emerald-400 mb-1" /><div className="text-[10px]">Tests</div><div className="text-xs text-muted-foreground">{detail.test_results?.filter((row) => row.ok).length || 0}/{detail.test_results?.length || 0}</div></div>
                  <div className="rounded border border-border/60 p-3"><Code2 className="w-4 h-4 text-neon-cyan mb-1" /><div className="text-[10px]">Files</div><div className="text-xs text-muted-foreground">{detail.changed_files?.length || 0}</div></div>
                  <div className="rounded border border-border/60 p-3"><Cpu className="w-4 h-4 text-violet-300 mb-1" /><div className="text-[10px]">Adapter</div><div className="text-xs text-muted-foreground break-all">{detail.adapter_id || detail.lineage?.adapter_id || 'N/A'}</div></div>
                  <div className="rounded border border-border/60 p-3"><Database className="w-4 h-4 text-indigo-300 mb-1" /><div className="text-[10px]">Version</div><div className="text-xs text-muted-foreground">{detail.version || detail.lineage?.version || 'N/A'}</div></div>
                </div>

                <div className="rounded border border-border/60 overflow-hidden">
                  <button type="button" onClick={() => setExpandedEvidence((value) => !value)} className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold hover:bg-secondary/30">
                    {isAdapter ? 'Training evidence and lineage' : 'Exact candidate patch'}
                    {expandedEvidence ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                  {expandedEvidence && (
                    <pre className="max-h-[28rem] overflow-auto p-4 text-[11px] leading-5 bg-black/30 border-t border-border/60 whitespace-pre-wrap">
                      {isAdapter
                        ? JSON.stringify({
                            lineage: detail.lineage || null,
                            metrics: detail.metrics || null,
                            benchmark_results: detail.benchmark_results || [],
                            test_results: detail.test_results || []
                          }, null, 2)
                        : detail.diff}
                    </pre>
                  )}
                </div>

                {detail.status === 'pending_review' && (
                  <div className="space-y-3">
                    {reviewAction === 'deny' && (
                      <div className="rounded border border-red-500/30 bg-red-500/10 p-3 space-y-2">
                        <textarea value={denyReason} onChange={(event) => setDenyReason(event.target.value)} rows={3} placeholder="Denial reason for future RSI cycles" className="w-full rounded border border-red-500/30 bg-background/80 px-3 py-2 text-sm outline-none" />
                        <div className="flex justify-end gap-2">
                          <button type="button" onClick={cancelReviewAction} className="px-3 py-2 text-xs rounded border border-border">Cancel</button>
                          <button type="button" onClick={confirmDeny} className="px-3 py-2 text-xs rounded border border-red-500/30 bg-red-500/15 text-red-200 flex items-center gap-2"><XCircle className="w-4 h-4" /> Confirm deny</button>
                        </div>
                      </div>
                    )}
                    {reviewAction === 'approve' && (
                      <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-3">
                        <p className="text-sm text-emerald-100">
                          {isAdapter
                            ? 'Approve this verified adapter candidate and activate it through the guarded model promotion path.'
                            : 'Approve this exact verified patch and activate it through the guarded deployment path.'}
                        </p>
                        <div className="flex justify-end gap-2 mt-3">
                          <button type="button" onClick={cancelReviewAction} className="px-3 py-2 text-xs rounded border border-border">Cancel</button>
                          <button type="button" onClick={confirmApprove} className="px-3 py-2 text-xs rounded border border-emerald-500/30 bg-emerald-500/15 text-emerald-200 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Confirm approve</button>
                        </div>
                      </div>
                    )}
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={requestDeny} disabled={Boolean(busy)} className="px-4 py-2 text-sm rounded border border-red-500/30 bg-red-500/10 text-red-300 disabled:opacity-40 flex items-center gap-2"><XCircle className="w-4 h-4" /> Deny</button>
                      <button type="button" onClick={requestApprove} disabled={Boolean(busy)} className="px-4 py-2 text-sm rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 disabled:opacity-40 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Approve and activate</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
    </section>
  )
}
