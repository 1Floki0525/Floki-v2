# Floki Neural Interface — Electron IPC vs Browser Transport Parity Matrix

> **Audit purpose:** Method-by-method comparison of the Electron IPC bridge (`window.floki` via preload.cjs) against the standalone browser transport (`FlokiBrowserTransport`). Every method is traced from the adapter through to the runtime HTTP endpoint.

---

## Convention

| Column | Meaning |
|--------|---------|
| **Adapter method** | As called on `flokiAdapter` in `adapter.js` |
| **Bridge method** | As exposed on `window.floki` by `preload.cjs` |
| **IPC channel** | Electron `ipcMain.handle(...)` channel string |
| **HTTP endpoint** | Runtime endpoint hit by `runtimeRequest()` (Electron) or `this.request()` (browser) |
| **Electron body** | Payload serialised by the IPC handler before calling `runtimeRequest` |
| **Browser body** | Payload serialised by `FlokiBrowserTransport` before calling `fetch` |
| **Electron response** | What the IPC handler returns to the renderer (after any unwrapping) |
| **Browser response** | What `FlokiBrowserTransport` returns to the caller |
| **Status** | `✅` exact match / `❌` mismatch or missing |
| **Notes** | Divergences that could cause functional bugs |

---

## Core Interface Methods

| # | Adapter method | Bridge method | IPC channel | HTTP endpoint | Electron body | Browser body | Electron response | Browser response | Status | Notes |
|---|---------------|---------------|-------------|---------------|---------------|--------------|-------------------|------------------|--------|-------|
| 1 | `getInitialStatus()` | `getInitialStatus()` | `floki:get-initial-status` | `GET /interface/status` | _(none — GET)_ | _(none — GET)_ | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 2 | `getSystemStatus()` | `getSystemStatus()` | `floki:get-system-status` | `GET /interface/services` | _(none — GET)_ | _(none — GET)_ | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 3 | `getTranscript(limit)` | `getTranscript(limit=200)` | `floki:get-transcript` | `GET /interface/transcript?limit=N` | Query param: `limit` from payload (default 200) | Query param: `limit` from arg (default 200) | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 4 | `clearTranscript()` | `clearTranscript()` | `floki:clear-transcript` | `POST /transcript/clear` | `{}` | `{}` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 5 | `sendMessage(text)` | `sendMessage(text)` | `floki:send-message` | `POST /chat` | `{ text }` | `{ text: t }` (trimmed) | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Both trim input and guard `requestInFlight`. Same endpoint, same body. |
| 6 | `interruptResponse()` → `bridge().interrupt()` | `interrupt()` | `floki:interrupt` | `POST /interrupt` | `{}` | `{}` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Adapter method name differs from bridge (`interruptResponse` vs `interrupt`) but functional path identical. |

---

## Vision Methods

| # | Adapter method | Bridge method | IPC channel | HTTP endpoint | Electron body | Browser body | Electron response | Browser response | Status | Notes |
|---|---------------|---------------|-------------|---------------|---------------|--------------|-------------------|------------------|--------|-------|
| 7 | `getVisionFrame()` | `getVisionFrame()` | `floki:get-vision-frame` | `GET /interface/vision/frame` | _(none — GET)_ | _(none — GET)_ | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 8 | `getLatestFrame()` | `getLatestFrame()` | `floki:get-latest-frame` | `GET /interface/vision/frame/base64` | _(none — GET)_ | _(none — GET)_ | `result.data \|\| null` | `(r && r.data) \|\| null` | ✅ | Both unwrap `.data`. Electron returns `result.data || null` where `result` is the HTTP body; browser does `(r && r.data) || null`. Semantically identical. |
| 9 | `getMjpegPort()` | `getMjpegPort()` | `floki:get-mjpeg-port` | _(no HTTP)_ — starts local MJPEG server | _(none)_ | _(none)_ | Port number (number) from `startMjpegFileStream()` | `null` (hardcoded stub) | ❌ | **Major mismatch.** Electron starts an on-disk MJPEG file stream server and returns the listening port. Browser returns `null`. |
| 10 | `getMjpegUrl()` | _(composed from getMjpegPort)_ | _(none — not a bridge method)_ | _(none)_ | _(none)_ | _(none)_ | Composed as ``http://127.0.0.1:${port}/live.mjpeg`` | `null` (hardcoded stub) | ❌ | Electron returns a real MJPEG URL; browser returns `null`. Browser cannot serve MJPEG. |
| 11 | `getObservation()` | `getObservation()` | `floki:get-observation` | `GET /interface/vision/observation` | _(none — GET)_ | _(none — GET)_ | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |

---

## Emotion / Affective State

| # | Adapter method | Bridge method | IPC channel | HTTP endpoint | Electron body | Browser body | Electron response | Browser response | Status | Notes |
|---|---------------|---------------|-------------|---------------|---------------|--------------|-------------------|------------------|--------|-------|
| 12 | `getEmotion()` | `getEmotion()` | `floki:get-emotion` | `GET /interface/emotion` | _(none — GET)_ | _(none — GET)_ | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 13 | `getAffectHistory(limit)` | `getAffectHistory(limit=360)` | `floki:get-affect-history` | `GET /interface/emotion/history?limit=N` | Query param: `limit` from payload (default 360) | Query param: `limit` from arg (default 360) | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |

---

## Status / Data Methods

| # | Adapter method | Bridge method | IPC channel | HTTP endpoint | Electron body | Browser body | Electron response | Browser response | Status | Notes |
|---|---------------|---------------|-------------|---------------|---------------|--------------|-------------------|------------------|--------|-------|
| 14 | `getSleepStatus()` | `getSleepStatus()` | `floki:get-sleep-status` | `GET /interface/sleep` | _(none — GET)_ | _(none — GET)_ | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 15 | `getNeuralEvents(limit)` | `getNeuralEvents(limit=250)` | `floki:get-neural-events` | `GET /interface/neural?limit=N` | Query param: `limit` from payload (default 250) | Query param: `limit` from arg (default 250) | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 16 | `getDreamTimeline()` | `getDreamTimeline()` | `floki:get-dream-timeline` | `GET /interface/dreams` | _(none — GET)_ | _(none — GET)_ | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |

---

## Settings

| # | Adapter method | Bridge method | IPC channel | HTTP endpoint | Electron body | Browser body | Electron response | Browser response | Status | Notes |
|---|---------------|---------------|-------------|---------------|---------------|--------------|-------------------|------------------|--------|-------|
| 17 | `getSettings()` | `getSettings()` | `floki:get-settings` | `GET /interface/settings` | _(none — GET)_ | _(none — GET)_ | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 18 | `updateSettings(section, values)` | `updateSettings(section, values)` | `floki:update-settings` | `POST /interface/settings/update` | `{ section, values: payload.values \|\| {} }` | `{ section, values }` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Semantically identical. Electron guards `values` with `|| {}`. |
| 19 | `resetSettings(section)` | `resetSettings(section)` | `floki:reset-settings` | `POST /interface/settings/reset` | `{ section: payload.section }` | `{ section }` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 20 | `resetAllSettings()` | `resetAllSettings()` | `floki:reset-all-settings` | `POST /interface/settings/reset` | `{ section: null }` | `{ section: null }` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 21 | `importSettings(settings)` | `importSettings(settings)` | `floki:import-settings` | `POST /interface/settings/import` | `{ settings: payload.settings \|\| {} }` | `{ settings }` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Semantically identical. |

---

## Action Methods

| # | Adapter method | Bridge method | IPC channel | HTTP endpoint | Electron body | Browser body | Electron response | Browser response | Status | Notes |
|---|---------------|---------------|-------------|---------------|---------------|--------------|-------------------|------------------|--------|-------|
| 22 | `control(action, argument)` | `control(action, argument=null)` | `floki:control` | `POST /interface/control/{action}` | `{ argument: payload.argument }` | `{ argument }` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |
| 23 | `openLog(service)` | `openLog(service)` | `floki:open-log` | `GET /interface/log/{service}` | _(none — GET, path param)_ | _(none — GET, path param)_ | `{ ok: true, file: result.path }` — also calls `shell.showItemInFolder` + `shell.openPath` | **Throws** `Error('log viewing is not available in browser')` | ❌ | **Functional mismatch.** Electron opens the log file in the OS file manager/editor. Browser throws unconditionally. |
| 24 | `setPushToTalk(active)` | `setPushToTalk(active)` | `floki:push-to-talk` | `POST /audio/push-to-talk` | `{ active: payload.active === true }` | `{ active: active === true }` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical. |

---

## Real-Time / Streaming

| # | Adapter method | Bridge method | IPC channel | HTTP endpoint | Electron body | Browser body | Electron response | Browser response | Status | Notes |
|---|---------------|---------------|-------------|---------------|---------------|--------------|-------------------|------------------|--------|-------|
| 25 | `getRuntimeWebSocketUrl()` | `getRuntimeWebSocketUrl()` | `floki:get-runtime-websocket-url` | _(no HTTP)_ | _(none)_ | _(none)_ | `ws://{runtime_host}:{runtime_port}/ws` (from `runtimeConfig`) | `${wsBase}/ws` (derived from API base URL) | ❌ | **Different URL source.** Electron reads config directly; browser derives from `window.floki_api_base_url` or default. |
| 26 | `subscribeRuntimeEvents(onEvent)` | _(composed)_ | _(not a single bridge call)_ | _(none — uses WebSocket)_ | _(none)_ | _(none)_ | Pure WebSocket — **no auth token** in URL. Reconnect uses `reconnectDelay` from settings. | WebSocket with **`?token=` query param**. Reconnect uses **exponential backoff** (1s-30s). | ❌ | **Auth mechanism differs:** Electron trusts local runtime; browser authenticates. **Reconnect strategy differs:** Electron uses fixed delay from settings; browser uses exponential backoff. Also Electron reads settings in adapter before connecting; browser does not. |

---

## Self-Improvement Methods

| # | Adapter method | Bridge method | IPC channel | HTTP endpoint | Electron body | Browser body | Electron response | Browser response | Status | Notes |
|---|---------------|---------------|-------------|---------------|---------------|--------------|-------------------|------------------|--------|-------|
| 27 | `getSelfImprovementStatus()` | `getSelfImprovementStatus()` | `floki:get-self-improvement-status` | `GET /self-improvement/status` | _(none — GET)_ | _(none — GET)_ | `result.status` (unwrapped) | `r.status` (unwrapped) | ✅ | Identical unwrapping. |
| 28 | `getSelfImprovementCandidates()` | `getSelfImprovementCandidates()` | `floki:get-self-improvement-candidates` | `GET /self-improvement/candidates` | _(none — GET)_ | _(none — GET)_ | `result.candidates \|\| []` | `r.candidates \|\| []` | ✅ | Identical. |
| 29 | `getSelfImprovementCandidate(id)` | `getSelfImprovementCandidate(id)` | `floki:get-self-improvement-candidate` | `GET /self-improvement/candidates/{id}` | _(none — GET, path param)_ | _(none — GET, path param)_ | `result.candidate` (raw, may be `undefined`) | `(r && r.candidate) \|\| null` (defaults to `null`) | ⚠️ | Minor: browser always returns `null` on missing; Electron returns `undefined`. Callers may need `?? null`. |
| 30 | `approveSelfImprovement(id)` | `approveSelfImprovement(id)` | `floki:approve-self-improvement` | `POST /self-improvement/approve` | `{ id, token: SELF_IMPROVEMENT_APPROVAL_TOKEN }` | `{ id: String(id) }` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ❌ | **Browser MISSING approval token.** Electron sends `token` from config; browser sends no token. Runtime may reject. |
| 31 | `denySelfImprovement(id, reason)` | `denySelfImprovement(id, reason='')` | `floki:deny-self-improvement` | `POST /self-improvement/deny` | `{ id, reason, token: SELF_IMPROVEMENT_APPROVAL_TOKEN }` | `{ id: String(id), reason }` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ❌ | **Browser MISSING approval token.** Same issue as approve. |
| 32 | `pauseSelfImprovement()` | `pauseSelfImprovement()` | `floki:pause-self-improvement` | `POST /self-improvement/pause` | `{ token: SELF_IMPROVEMENT_APPROVAL_TOKEN }` | `{}` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ❌ | **Browser MISSING approval token.** |
| 33 | `resumeSelfImprovement()` | `resumeSelfImprovement()` | `floki:resume-self-improvement` | `POST /self-improvement/resume` | `{ token: SELF_IMPROVEMENT_APPROVAL_TOKEN }` | `{}` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ❌ | **Browser MISSING approval token.** |
| 34 | `runSelfImprovementNow(objective, kind)` | `runSelfImprovementNow(objective='', kind='code')` | `floki:run-self-improvement-now` | `POST /self-improvement/run-now` | `{ objective, kind, token: SELF_IMPROVEMENT_APPROVAL_TOKEN }` + **extended timeout** (run_now_ack_timeout + 30s) | `{ objective, kind }` — **no token**, default timeout (120s) | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ❌ | **Browser MISSING approval token AND extended timeout.** Electron sets timeout to `run_now_ack_timeout_ms + 30000`; browser uses default 120s timeout. Sandbox startup may timeout in browser. |
| 35 | `abortSelfImprovement(kind, reason)` | `abortSelfImprovement(kind='code', reason='')` | `floki:abort-self-improvement` | `POST /self-improvement/abort` | `{ kind, reason, token: SELF_IMPROVEMENT_APPROVAL_TOKEN }` | `{ kind, reason }` | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ❌ | **Browser MISSING approval token.** |
| 36 | `getSelfImprovementActivity(params)` | `getSelfImprovementActivity(params={})` | `floki:get-self-improvement-activity` | `GET /self-improvement/activity?init=&audit_cursor=&sandbox_cursor=&limit=` | Query params: `init`, `audit_cursor`, `sandbox_cursor`, `limit` from payload | Query params: `init`, `audit_cursor`, `sandbox_cursor`, `limit` from params | Raw HTTP response body (JSON) | Raw HTTP response body (JSON) | ✅ | Identical query param construction. |

---

## Summary

| Category | Total | ✅ Match | ⚠️ Minor | ❌ Mismatch |
|----------|-------|----------|----------|------------|
| Core interface | 6 | 6 | 0 | 0 |
| Vision | 5 | 2 | 0 | 3 |
| Emotion | 2 | 2 | 0 | 0 |
| Status / Data | 3 | 3 | 0 | 0 |
| Settings | 5 | 5 | 0 | 0 |
| Actions | 3 | 2 | 0 | 1 |
| Real-time / Streaming | 2 | 0 | 0 | 2 |
| Self-improvement | 10 | 4 | 1 | 5 |
| **Total** | **36** | **24** | **1** | **11** |

**Match rate: 24/36 = 66.7%** (25/36 = 69.4% if counting minor as match).

---

## Critical Issues to Fix

| Priority | Method(s) | Issue |
|----------|-----------|-------|
| **HIGH** | `approveSelfImprovement`, `denySelfImprovement`, `pauseSelfImprovement`, `resumeSelfImprovement`, `runSelfImprovementNow`, `abortSelfImprovement` | Browser transport never sends `SELF_IMPROVEMENT_APPROVAL_TOKEN`. Runtime will reject these operations. |
| **HIGH** | `runSelfImprovementNow` | Browser uses default 120s timeout; sandbox startup may exceed this. Need extended timeout. |
| **MEDIUM** | `getMjpegPort`, `getMjpegUrl` | Browser has no MJPEG streaming capability. Returns `null` vs real port/URL. |
| **MEDIUM** | `openLog` | Browser throws instead of attempting HTTP-based log retrieval. |
| **MEDIUM** | `subscribeRuntimeEvents` | Browser sends auth token via `?token=` query param; Electron does not. Reconnect strategy differs (fixed vs exponential backoff). Browser also does not read settings for `reconnectDelay`. |
| **LOW** | `getSelfImprovementCandidate` | Browser returns `null` explicitly on missing; Electron returns `undefined`. Inconsistency may cause bugs if callers don't use nullish coalescing. |
