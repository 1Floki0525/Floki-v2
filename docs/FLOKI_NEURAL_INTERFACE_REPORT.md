# Floki Neural Interface — App Architecture Report

## 1. Overview

**Purpose:** A neon-blue, cyberpunk-themed PWA dashboard for monitoring and interacting with the Floki-v2 digital being. Built as a React SPA on the Base44 platform using Vite + Tailwind CSS + shadcn/ui.

**Goal for integration:** Replace the current terminal-based Floki interface with this visual dashboard. The entire frontend already exists — the integration work is on the backend side: replacing mock data with real REST API calls and WebSocket streaming from the Floki-v2 server.

**Tech stack:**
- React 18, React Router v6, Vite
- Tailwind CSS with custom neon theme
- shadcn/ui component library
- Lucide React icons
- Framer Motion (animations)
- Recharts (emotion graphs)
- @tanstack/react-query
- date-fns, lodash, react-markdown

---

## 2. File Structure

```
src/
├── App.jsx                          # Router + providers
├── main.jsx                         # Entry point
├── index.css                        # Design tokens, theme, utilities
├── tailwind.config.js               # Tailwind theme config
├── index.html                       # HTML shell
├── api/
│   └── base44Client.js             # Pre-initialized Base44 SDK instance
├── lib/
│   ├── AuthContext.jsx              # Auth provider (Base44 built-in)
│   ├── query-client.js              # React Query client instance
│   └── utils.js                     # cn() utility for class merging
├── stores/
│   └── settingsStore.js             # localStorage-backed settings store
├── hooks/
│   ├── useSettings.js               # React hook for settings
│   └── use-mobile.jsx               # Mobile detection hook
├── integrations/floki/
│   ├── adapter.js                   # CENTRAL INTEGRATION ADAPTER (singleton)
│   ├── mockAdapter.js               # Mock data generator (current implementation)
│   ├── types.js                     # All type definitions & factory functions
│   ├── restClient.js                # Placeholder for real REST client
│   └── websocketClient.js           # Placeholder for real WebSocket client
├── pages/
│   ├── Home.jsx                     # Main shell — nav rail + tab routing
│   ├── ChatInterface.jsx            # Chat tab container (split-pane layout)
│   ├── DreamsDashboard.jsx          # Dreams tab — timeline + filters + detail
│   ├── NeuralStream.jsx             # Neural Stream tab wrapper
│   ├── SystemDashboard.jsx          # System tab — services + controls
│   ├── SettingsPage.jsx             # Settings tab — all configuration
│   ├── Login.jsx                    # Auth page (Base44 template)
│   ├── Register.jsx                 # Auth page (Base44 template)
│   ├── ForgotPassword.jsx           # Auth page (Base44 template)
│   └── ResetPassword.jsx            # Auth page (Base44 template)
├── components/
│   ├── shared/
│   │   ├── NavRail.jsx              # Left sidebar navigation
│   │   ├── NeonPanel.jsx            # Reusable glass-panel wrapper
│   │   └── StatusIndicator.jsx      # Colored dot + label component
│   ├── chat/
│   │   ├── ChatPanel.jsx            # Main chat area with message streaming
│   │   ├── ChatMessage.jsx          # Individual message bubble
│   │   ├── EmptyChat.jsx            # Empty state for chat
│   │   ├── FlokiStateIndicator.jsx  # Shows processing state (Thinking, Looking, etc.)
│   │   ├── LatencyPanel.jsx         # Response timing breakdown
│   │   └── MessageComposer.jsx      # Input bar with send/interrupt buttons
│   ├── dreams/
│   │   ├── DreamsHeader.jsx         # Session stats summary
│   │   ├── DreamsTimeline.jsx       # Visual REM cycle timeline with fragment dots
│   │   ├── DreamsFilters.jsx        # Filter sidebar (emotion tags, duration, memory tags)
│   │   ├── DreamFragmentCard.jsx    # Detail panel with emotional quadrant + narrative
│   │   └── RemCycleBar.jsx          # Single REM cycle bar on timeline
│   ├── neural-stream/
│   │   ├── NeuralStreamView.jsx      # Real-time neural event log with filters
│   │   └── NeuralEventItem.jsx      # Single neural event row
│   ├── emotions/
│   │   └── EmotionGraph.jsx         # Recharts multi-line emotion graph
│   ├── vision/
│   │   ├── VisionPanel.jsx          # Vision camera feed + bounding boxes
│   │   └── ObservationCard.jsx      # Vision observation text display
│   ├── sleep/
│   │   └── SleepStatus.jsx          # Sleep state monitor
│   ├── system/
│   │   ├── ServiceCard.jsx          # Individual service status card
│   │   └── SystemControls.jsx       # Hardware control buttons
│   ├── settings/
│   │   ├── SettingsSection.jsx      # Collapsible settings group
│   │   └── SettingRow.jsx           # Single setting control (toggle/slider/select/text/number)
│   ├── AuthLayout.jsx, GoogleIcon.jsx, ProtectedRoute.jsx, UserNotRegisteredError.jsx, ScrollToTop.jsx
│   └── ui/                          # shadcn/ui components (button, dialog, input, select, slider, switch, etc.)
```

---

## 3. Navigation System (5 Tabs)

The `pages/Home.jsx` shell renders a `NavRail` on the left and the active tab component on the right. No React Router for tab switching — it uses local state:

```
Tab ID      | Label            | Component
------------|------------------|-----------------------------
chat        | Chat Interface   | pages/ChatInterface.jsx
dreams      | Dreams           | pages/DreamsDashboard.jsx
neural      | Neural Stream    | pages/NeuralStream.jsx
system      | System           | pages/SystemDashboard.jsx
settings    | Settings         | pages/SettingsPage.jsx
```

---

## 4. Integration Architecture (CRITICAL)

### 4.1 The Adapter Pattern

**All UI components interact with Floki exclusively through `integrations/floki/adapter.js`.**

```
UI Components → flokiAdapter (singleton) → mockAdapter.js  (CURRENT)
                                        → restClient.js    (FUTURE)
                                        → websocketClient.js (FUTURE)
```

The adapter exposes these methods that the UI calls:

| Method | Returns | Used By |
|--------|---------|---------|
| `getInitialStatus()` | `{ online, mode, visionActive, hearingActive, state, sleepState }` | Home.jsx (NavRail) |
| `getSystemStatus()` | `ServiceStatus[]` (12 services) | SystemDashboard |
| `simulateResponse({signal, onStateChange, onToken, onLatency, onComplete})` | void (streaming via callbacks) | ChatPanel |
| `generateNeuralEvent()` | `NeuralEvent` | NeuralStreamView |
| `getVisionFrame()` | `VisionFrame` (objects, faces, scene) | VisionPanel |
| `getObservation()` | `{ text, age, freshness, source, lastUpdated }` | VisionPanel |
| `generateEmotion(prev)` | `EmotionState` (10 dimensions) | EmotionGraph |
| `getSleepStatus()` | `SleepStatus` | SleepStatus |
| `getDreamTimeline()` | `{ sessionDate, cycles[], fragments[], totalFragments, ... }` | DreamsDashboard |
| `getLatencyHealth(ms, type)` | `'Healthy' \| 'Slow' \| 'Critical'` | ChatPanel |
| `isMockMode()` | `boolean` | Settings |

### 4.2 Mock Data Generator (`mockAdapter.js`)

Generates realistic synthetic data for all subsystems:
- **8 pre-written conversational responses** with markdown, code blocks, emotional commentary
- **22 neural event templates** spanning all 16 neural modules (Hearing, Vision, Thalamus, Temporal, Amygdala, Hippocampus, Memory, Personality, Frontal, Broca, Pineal, Sleep, REM, Dream, Emotions, System)
- **6 mock vision objects** (Person, Chair, Monitor, Photograph, Keyboard, Lamp)
- **2 mock face detections** (Known/Unknown Person)
- **Emotion drift model**: random walk with 0.06 max delta per tick across 10 emotional dimensions
- **Dream timeline**: 4 REM cycles with 2-4 fragments each, 12 distinct dream narratives with emotional tones, memory tags, and visual elements
- **Latency trace**: realistic pipeline timings (transcription, memory, vision, cognition, TTS, total)

### 4.3 Real Backend Integration (TODO)

When connecting to real Floki-v2:

1. **Update `adapter.js`:**
   - Set `this.mockMode = false`
   - Replace each `mock.*` call with `restClient.*` or `websocketClient.*`
   - Implement `connect(apiUrl, wsUrl)`, `disconnect()`, `sendMessage(text)`, `interruptResponse()`

2. **Build `restClient.js`:**
   - REST endpoints: `GET /status`, `GET /vision/frame`, `GET /vision/observation`, `GET /system/services`, `GET /sleep`, `GET /dreams/timeline`
   - `POST /chat/message` (or WebSocket for streaming)
   - `POST /system/restart/:service`, `POST /system/control/:action`

3. **Build `websocketClient.js`:**
   - Real-time neural events stream
   - Real-time emotion updates
   - Response token streaming
   - State change notifications

4. **Search for `FLOKI_INTEGRATION_PLACEHOLDER` comments** — there are ~30 of these marking where real integration code goes.

---

## 5. Tab-by-Tab Feature Breakdown

### 5.1 Chat Interface (`pages/ChatInterface.jsx`)

Layout: 60% chat panel + 40% side panel (vision + emotions + sleep)

**Features:**
- Streaming message display with Markdown rendering
- Processing state indicator (Idle → Listening → Thinking → Remembering → Looking → Responding → Speaking)
- Per-message latency panel showing pipeline breakdown
- Interrupt button stops current response
- Auto-scroll with "jump to newest" button
- Empty state with prompt suggestions
- Message composer with Enter-to-send and character count

**Side panel components:**
- VisionPanel: camera feed with bounding box overlays (objects + faces)
- EmotionPanel: multi-line emotion graph from Recharts
- SleepPanel: sleep state, alertness, sleep pressure bars

### 5.2 Dreams Dashboard (`pages/DreamsDashboard.jsx`)

Layout: Header → Filter Sidebar → [Timeline (3/5) + Detail Panel (2/5)]

**Features:**
- Session header with stats: sleep duration, REM cycles, fragment count, lucid moments, dominant theme
- **Filter sidebar** with three filter dimensions:
  - Emotional state tags: All, Peaceful, Vivid, Anxious, Euphoric, Melancholic, Neutral
  - Duration: Any, Brief (<30s), Medium (30–90s), Extended (>90s)
  - Memory fragment tags: multi-select chips (library, faces, minecraft, geometry, etc.)
- Visual REM cycle timeline with fragment dots (color-coded: normal cyan, amber for lucid, bright cyan for selected)
- Filtered-out fragments dim to 20% opacity and shrink to 75% scale
- Filter count badge and "Clear all" button
- **Detail panel** (DreamFragmentCard) shows when clicking a fragment:
  - Full narrative in styled quote block with lucidity indicator
  - **2D valence-arousal quadrant visualization**: a dot plotted on a 2x2 grid with labeled zones (high/low valence × high/low arousal)
  - Emotional label badge (Peaceful/Euphoric/Anxious/Melancholic/Vivid/Neutral)
  - Valence & arousal bar meters
  - REM cycle, timestamp, duration, intensity
  - Memory tags and visual elements as colored badges

### 5.3 Neural Stream (`pages/NeuralStream.jsx`)

**Features:**
- Real-time event log (new events every 800–1200ms)
- Pause/Resume stream
- Search by event text, trace ID, or module
- Module filter (16 neural modules)
- Severity filter (info, warning, error, debug)
- Privacy level filter (Public, Safe Summary, Private Metadata, Redacted)
- Compact/Expanded view toggle
- Auto-scroll with manual override
- Export filtered events as JSON
- Clear all events
- Max 1000 events stored

### 5.4 System Dashboard (`pages/SystemDashboard.jsx`)

**Features:**
- Service status grid (4-column responsive): Floki Core, Cognition, Vision, Hearing, Speech, Memory, Emotion, Sleep Scheduler, Dream Engine, Local API, WebSocket Connection, Minecraft Bridge
- Each card shows: status dot, uptime, latency, last heartbeat, last error
- Per-service: Restart button, View Logs button
- 5-second auto-refresh
- **System Controls** panel with 12 action buttons:
  - Chat: Start/Stop/Restart Chat Mode
  - Hardware: Wake Floki, Request Sleep, Pause/Resume Auto-Sleep
  - Sensors: Restart Vision, Restart Hearing, Restart Speech
  - Emergency: Interrupt Response
- Toast notifications for all mock actions

### 5.5 Settings Page (`pages/SettingsPage.jsx`)

9 collapsible sections, all persisted to localStorage:

| Section | Settings |
|---------|----------|
| Connection | API URL, WebSocket URL, Auto-reconnect, Reconnect delay, Request timeout, Mock mode toggle |
| Chat | Stream responses, Show timestamps, Markdown, Compact messages, Enter to send, Max local history |
| Voice | Mic/Speaker toggles, Hands-free, Push to talk, Wake word, Wake phrase, Volume, Speech rate |
| Vision | Object/face boxes, Recognized names, Confidence display, Scene recognition, Freshness threshold, Privacy blackout |
| Emotions | Graph time range (1m/5m/15m/session), Update frequency, Graph smoothing |
| Neural Stream | Auto scroll, Max events, Compact view |
| Appearance | Neon intensity, Glow intensity, Animation level, Font size, Interface scale, Panel density, Reduced motion |
| Latency | First token target, First audio target, Slow/critical thresholds, Detailed stage timing |
| Privacy | Hide vision, Hide names, Redact metadata, Allow export, Clear stored prefs |

**Import/Export:** Full settings JSON export/import, per-section reset, global reset.

---

## 6. Design System

### 6.1 Theme (Dark, Neon-Blue)

All tokens defined in `index.css` as CSS custom properties mapped to HSL values:

```
Background:    #0a0c14  (222° 47% 5%)
Foreground:    #d6f5ff  (195° 100% 95%)
Card/Panel:    #0d1119  (222° 47% 8%)
Primary/Cyan:  #00e5ff  (185° 100% 50%)
Accent/Blue:   #1a8cff  (210° 100% 55%)
Green:         #33cc66  (140° 70% 50%)
Amber:          #e6a817  (38° 92% 50%)
Red:            #d93025  (0° 72% 51%)
Border:         #1e293b  (210° 40% 18%)
```

### 6.2 Utility Classes

- `.neon-glow` — Subtle cyan box shadow
- `.neon-glow-strong` — Stronger cyan box shadow
- `.neon-border` — Cyan border at 20% opacity
- `.neon-text` — Cyan text shadow
- `.glass-panel` — Translucent card with blur + border
- `.animate-neon-pulse` — 2s opacity pulse
- `.animate-scan` — Scan line animation

### 6.3 Typography

- Headings: Inter (semibold, 0.2em tracking, uppercase)
- Body: Inter (antialiased)
- Mono: JetBrains Mono (for code, timestamps, labels, technical text)
- All labels use `text-[10px] font-mono uppercase tracking-wider`

---

## 7. Data Types (from `integrations/floki/types.js`)

### 7.1 Enums/Constants

```
FlokiState:     Idle, Listening, Hearing Speech, Transcribing, Thinking, Remembering, Looking, Responding, Speaking, Sleeping, Error
SleepState:     Awake, Alert, Relaxed, Tired, Entering Sleep, Asleep, REM Cycle 1-2, Dreaming, Waking
NeuralModule:   Hearing, Vision, Thalamus, Temporal, Amygdala, Emotions, Hippocampus, Memory, Personality, Pineal, Frontal, Broca, Sleep, REM, Dream, System
EventSeverity:  info, warning, error, debug
PrivacyLevel:   Public, Safe Summary, Private Metadata, Redacted
ServiceStatus:  Running, Stopped, Degraded
LatencyHealth:  Healthy, Slow, Critical
MessageType:    typed, spoken
ConnectionState: connected, disconnected, connecting, reconnecting, error
```

### 7.2 Core Data Shapes

**ChatMessage:** `{ id, role, content, type, timestamp, isStreaming, latency }`

**LatencyTrace:** `{ transcriptionTime, memoryContextTime, visionContextTime, cognitionTime, timeToFirstToken, totalGenerationTime, textToSpeechTime, totalResponseTime }`

**VisionFrame:** `{ objects[], faces[], scene: {label, confidence}, timestamp, frameRate, connectionStatus }`

**NeuralEvent:** `{ id, timestamp, module, eventType, summary, severity, traceId, duration, privacyLevel }`

**ServiceStatus:** `{ name, status, lastHeartbeat, uptime, latency, lastError }`

**EmotionState:** `{ valence, arousal, trust, curiosity, hope, fear, frustration, attachment, confidence, uncertainty, timestamp }`

**SleepStatus:** `{ state, alertness, sleepPressure, remActive, currentRemCycle, dreaming, thinking, speaking, listening, externalEyesActive, currentMode, lastInteraction, sessionUptime }`

**DreamFragment:** `{ id, timestamp, remCycleIndex, cyclePhase, duration, memoryTags[], visualElements[], emotionalTone: {valence, arousal}, narrative, intensity, isLucid, status }`

**RemCycle:** `{ id, cycleNumber, startTime, endTime, duration, fragmentCount, intensity, lucidMoments, dominantEmotion, sleepPressureAtStart, alertnessAtEnd }`

---

## 8. State Management

- **Tab state:** Local `useState` in `Home.jsx`
- **Settings:** Custom store in `stores/settingsStore.js` using localStorage with a pub/sub listener pattern. React hook: `hooks/useSettings.js`
- **Chat messages:** Local `useState` in `ChatPanel.jsx`
- **Neural events:** Local `useState` in `NeuralStreamView.jsx`
- **System services:** Local `useState` in `SystemDashboard.jsx` with 5s polling
- **Emotions:** Local `useState` with interval-based drift updates
- **Vision:** Local `useState` with interval-based polling
- **Dream timeline:** Local `useState`, loaded once on mount, refreshable
- **Dream filters:** Local `useState` in `DreamsDashboard.jsx`
- **Floki status:** Local `useState` in `Home.jsx` with 5s polling

No global state manager (Redux/Zustand) is used — all state is component-local.

---

## 9. Auth & Routing (`App.jsx`)

- Base44 built-in auth with `AuthProvider`, `ProtectedRoute`
- Auth pages: `/login`, `/register`, `/forgot-password`, `/reset-password`
- Main app: `/` → `Home.jsx` (all 5 tabs inside this single route)
- 404: `*` → `Home.jsx`
- QueryClientProvider, Toaster (Sonner), dark theme toast styling

---

## 10. Integration Checklist (for floki-v2 repo)

When integrating into the floki-v2 repository to replace the terminal interface:

1. **Set up the React build** inside floki-v2 (Vite dev server or static build served by the Floki backend)
2. **Configure API base URLs** in Settings → Connection (default: `http://localhost:7700` REST, `ws://localhost:7700/ws` WebSocket)
3. **Implement the REST endpoints** that the adapter expects (see section 4.3)
4. **Implement the WebSocket stream** for neural events, emotion updates, and response tokens
5. **Replace `adapter.js` mock calls** with real REST/WS client calls
6. **Remove mock mode toggle** from Settings once real backend is stable
7. **Ensure data shapes match** the type definitions in `types.js` exactly
8. **Serve static assets** (no special build requirements beyond standard Vite output)

---

## 11. Key Files for Integration Work

| File | Role |
|------|------|
| `integrations/floki/adapter.js` | **PRIMARY FILE** — swap mock → real here |
| `integrations/floki/types.js` | Data contracts — real backend must match these shapes |
| `integrations/floki/mockAdapter.js` | Reference for expected data shapes and behavior |
| `integrations/floki/restClient.js` | **Create this** — REST API client |
| `integrations/floki/websocketClient.js` | **Create this** — WebSocket client |
| `stores/settingsStore.js` | Connection URLs live here |
| `pages/SettingsPage.jsx` | Connection settings UI |
