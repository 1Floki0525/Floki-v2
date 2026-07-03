package com.floki.neural.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.floki.neural.data.FlokiBackend
import com.floki.neural.data.FlokiAudioRecorder
import com.floki.neural.data.ProfileStore
import com.floki.neural.data.ServerProfile
import com.floki.neural.data.booleanOrNull
import com.floki.neural.data.intOrNull
import com.floki.neural.data.longOrNull
import com.floki.neural.data.normalizeFlokiSessionCredential
import com.floki.neural.data.stringOrNull
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.WebSocket
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

data class ChatMessage(
    val id: String,
    val role: String,
    val content: String,
    val timestamp: Long,
    val partial: Boolean
)

data class DreamItem(
    val id: String,
    val title: String,
    val story: String,
    val remCycle: Int?,
    val timestamp: Long
)

data class NeuralItem(
    val id: String,
    val module: String,
    val summary: String,
    val timestamp: Long
)

data class ServiceItem(
    val key: String,
    val name: String,
    val status: String,
    val lifecycleState: String,
    val detail: String,
    val lastError: String?,
    val clientApp: Boolean = false,
    val enabled: Boolean = true,
    val startAvailable: Boolean = false,
    val stopAvailable: Boolean = false,
    val resetAvailable: Boolean = false,
    val connectedClientCount: Int? = null,
    val healthyClientCount: Int? = null,
    val transportType: String? = null,
    val controlGeneration: Long? = null
)

data class CandidateItem(
    val id: String,
    val status: String,
    val objective: String,
    val riskLevel: String,
    val summary: String,
    val createdAt: Long
)

data class RuntimeSnapshot(
    val state: String = "unknown",
    val mode: String = "chat.local",
    val model: String = "unknown",
    val online: Boolean = false,
    val ready: Boolean = false,
    val vision: Boolean = false,
    val hearing: Boolean = false,
    val memory: Boolean = false,
    val speech: Boolean = false
)

data class SleepSnapshot(
    val state: String = "unknown",
    val currentRemCycle: Int? = null,
    val remainingMs: Long? = null,
    val nextRemCountdownMs: Long? = null,
    val completedRemCycles: Int? = null,
    val totalRemCycles: Int? = null,
    val dreaming: Boolean = false
)

data class RsiSnapshot(
    val phase: String = "unknown",
    val state: String = "unknown",
    val paused: Boolean = false,
    val workerRunning: Boolean = false,
    val modelProxyReady: Boolean = false,
    val currentRunId: String? = null,
    val currentContainer: String? = null,
    val lastError: String? = null
)

data class FlokiUiState(
    val profile: ServerProfile = ServerProfile(),
    val connected: Boolean = false,
    val websocketConnected: Boolean = false,
    val refreshing: Boolean = false,
    val busyAction: String? = null,
    val runtime: RuntimeSnapshot = RuntimeSnapshot(),
    val sleep: SleepSnapshot = SleepSnapshot(),
    val rsi: RsiSnapshot = RsiSnapshot(),
    val chat: List<ChatMessage> = emptyList(),
    val dreams: List<DreamItem> = emptyList(),
    val neural: List<NeuralItem> = emptyList(),
    val services: List<ServiceItem> = emptyList(),
    val candidates: List<CandidateItem> = emptyList(),
    val rsiTerminalText: String = "",
    val rsiTerminalGeneration: Long = 0,
    val rsiTerminalActive: Boolean = false,
    val rsiTerminalError: String? = null,
    val visionFrameBytes: ByteArray? = null,
    val visionFrameGeneration: Int = 0,
    val recording: Boolean = false,
    val hasAudioPermission: Boolean = false,
    val message: String? = null,
    val error: String? = null
)

class FlokiViewModel(application: Application) : AndroidViewModel(application) {
    private val profileStore = ProfileStore(application.applicationContext)
    private val audioRecorder = FlokiAudioRecorder()
    private var profile = profileStore.load()
    private var backend = FlokiBackend(profile)
    private var socket: WebSocket? = null
    private var pollingJob: Job? = null
    private var heartbeatJob: Job? = null
    private var terminalPollingJob: Job? = null
    private var visionPollingJob: Job? = null
    private var reconnectJob: Job? = null
    private var voiceJob: Job? = null
    private var transportGeneration = 0
    private val mobileClientId = profileStore.loadOrCreateMobileClientId()
    private val mobileSessionId = "mobile-session-${UUID.randomUUID()}"
    private var normalMobileTransportEnabled = true
    private var observedMobileGeneration: Long? = null

    private var terminalCursor = 0L
    private var terminalGeneration = 0L

    private val refreshInProgress = AtomicBoolean(false)
    private val terminalRefreshInProgress = AtomicBoolean(false)

    private val _state = MutableStateFlow(FlokiUiState(profile = profile))
    val state: StateFlow<FlokiUiState> = _state.asStateFlow()

    init {
        restartTransport()
        refresh()
        refreshRsiTerminal(reset = true)
    }

    fun saveProfile(
        host: String,
        portText: String,
        pollText: String,
        sessionCredential: String,
        useTls: Boolean,
        developerMode: Boolean
    ) {
        val cleanHost = host.trim()
            .removePrefix("https://")
            .removePrefix("http://")
            .trimEnd('/')
        val port = portText.toIntOrNull()
        val poll = pollText.toLongOrNull()
        val cleanCredential = normalizeFlokiSessionCredential(sessionCredential)

        when {
            cleanHost.isBlank() -> setError("Server host cannot be empty")
            cleanHost.contains('/') -> setError("Server host must not include a path")
            !developerMode && cleanHost.isLoopbackHost() -> setError(
                "Loopback profiles require Developer local profile"
            )
            port == null || port !in 1..65535 -> setError("Port must be between 1 and 65535")
            poll == null || poll !in 1_000L..60_000L -> setError(
                "Poll interval must be between 1000 and 60000 ms"
            )
            !developerMode && cleanCredential.isBlank() -> setError(
                "Public gateway profiles require an approved-user session credential"
            )
            else -> {
                profile = ServerProfile(
                    host = cleanHost,
                    port = port,
                    pollIntervalMs = poll,
                    sessionCredential = cleanCredential,
                    useTls = useTls,
                    developerMode = developerMode
                )
                profileStore.save(profile)
                profile = profileStore.load()
                _state.update {
                    it.copy(
                        profile = profile,
                        message = "Connection profile saved",
                        error = null
                    )
                }
                restartTransport()
                refresh()
                refreshRsiTerminal(reset = true)
            }
        }
    }

    fun refresh() {
        if (!refreshInProgress.compareAndSet(false, true)) return
        viewModelScope.launch {
            _state.update { it.copy(refreshing = true) }
            try {
                val status = backend.getObject("/interface/status")
                val servicesResult = runCatching { backend.getArray("/interface/services") }
                val services = servicesResult.getOrNull()?.let(::parseServices)
                services?.firstOrNull { it.key == MOBILE_APP_KEY }?.let(::applyMobileServiceControl)
                val normalTraffic = normalMobileTransportEnabled
                val transcriptResult = runCatching {
                    if (normalTraffic) backend.getArray("/interface/transcript?limit=200") else JSONArray()
                }
                val dreamsResult = runCatching {
                    if (normalTraffic) backend.getObject("/interface/dreams") else JSONObject()
                }
                val neuralResult = runCatching {
                    if (normalTraffic) backend.getArray("/interface/neural?limit=250") else JSONArray()
                }
                val sleepResult = runCatching {
                    if (normalTraffic) backend.getObject("/interface/sleep") else JSONObject()
                }
                val rsiResult = runCatching {
                    if (normalTraffic) backend.getObject("/self-improvement/status") else JSONObject()
                }
                val candidatesResult = runCatching {
                    if (normalTraffic) backend.getObject("/self-improvement/candidates") else JSONObject()
                }

                _state.update { current ->
                    current.copy(
                        connected = true,
                        runtime = parseRuntime(status),
                        services = services ?: current.services,
                        chat = transcriptResult.getOrNull()?.let(::parseChat)
                            ?: current.chat,
                        dreams = dreamsResult.getOrNull()?.let(::parseDreams)
                            ?: current.dreams,
                        neural = neuralResult.getOrNull()?.let(::parseNeural)
                            ?: current.neural,
                        sleep = sleepResult.getOrNull()?.let(::parseSleep)
                            ?: current.sleep,
                        rsi = rsiResult.getOrNull()?.let(::parseRsi)
                            ?: current.rsi,
                        candidates = candidatesResult.getOrNull()?.let(::parseCandidates)
                            ?: current.candidates,
                        refreshing = false,
                        error = null
                    )
                }
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        connected = false,
                        refreshing = false,
                        error = error.message ?: "Could not reach Floki-v2"
                    )
                }
            } finally {
                refreshInProgress.set(false)
            }
        }
    }

    fun refreshRsiTerminal(reset: Boolean = false) {
        if (!normalMobileTransportEnabled) return
        if (reset) {
            terminalCursor = 0L
            terminalGeneration = 0L
            _state.update { it.copy(rsiTerminalText = "", rsiTerminalError = null) }
        }
        if (!terminalRefreshInProgress.compareAndSet(false, true)) return

        viewModelScope.launch {
            try {
                val result = backend.getObject(
                    "/self-improvement/terminal" +
                        "?cursor=$terminalCursor" +
                        "&max_bytes=65536"
                )
                if (result.booleanOrNull("ok") == false) {
                    throw IllegalStateException(
                        result.stringOrNull("error") ?: "RSI terminal request failed"
                    )
                }

                val nextGeneration = result.longOrNull("generation") ?: 0L
                val nextCursor = result.longOrNull("next_cursor") ?: terminalCursor
                val incoming = result.stringOrNull("text") ?: ""

                _state.update { current ->
                    if (nextGeneration != terminalGeneration && terminalGeneration != 0L) {
                        // New run or file generation; reset
                        terminalCursor = nextCursor
                        terminalGeneration = nextGeneration
                        current.copy(
                            rsiTerminalText = incoming,
                            rsiTerminalGeneration = nextGeneration,
                            rsiTerminalActive = result.booleanOrNull("active") == true,
                            rsiTerminalError = null
                        )
                    } else {
                        terminalCursor = nextCursor
                        terminalGeneration = nextGeneration
                        current.copy(
                            rsiTerminalText = current.rsiTerminalText + incoming,
                            rsiTerminalGeneration = nextGeneration,
                            rsiTerminalActive = result.booleanOrNull("active") == true,
                            rsiTerminalError = null
                        )
                    }
                }
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        rsiTerminalError = error.message ?: "RSI terminal disconnected"
                    )
                }
            } finally {
                terminalRefreshInProgress.set(false)
            }
        }
    }

    fun flushVisionFrame() {
        _state.update { it.copy(visionFrameBytes = null) }
    }

    fun refreshVisionFrame() {
        if (!normalMobileTransportEnabled) return
        viewModelScope.launch {
            try {
                val bytes = backend.getBytes("/interface/vision/frame/latest.jpg")
                _state.update {
                    it.copy(
                        visionFrameBytes = bytes,
                        visionFrameGeneration = it.visionFrameGeneration + 1
                    )
                }
            } catch (_: Exception) {
            }
        }
    }

    fun sendChat(text: String) {
        if (!normalMobileTransportEnabled) {
            setError("Mobile App service is stopped; start it from System to resume chat.")
            return
        }
        val value = text.trim()
        if (value.isBlank()) return
        runAction("chat") {
            backend.post("/chat", JSONObject().put("text", value))
            "Message sent"
        }
    }

    fun updateAudioPermission(granted: Boolean) {
        _state.update { it.copy(hasAudioPermission = granted) }
    }

    fun sendVoice() {
        if (!normalMobileTransportEnabled) {
            setError("Mobile App service is stopped; start it from System to resume voice.")
            return
        }
        if (!_state.value.hasAudioPermission) {
            setError("Microphone permission is required for voice input")
            return
        }
        if (voiceJob?.isActive == true) return

        voiceJob = viewModelScope.launch {
            _state.update {
                it.copy(
                    recording = true,
                    busyAction = "voice",
                    message = null,
                    error = null
                )
            }
            try {
                val wavBytes = audioRecorder.recordWav()
                val response = backend.postAudio("/audio/remote-utterance", wavBytes)
                if (response.booleanOrNull("ok") == false) {
                    throw IllegalStateException(
                        response.stringOrNull("error") ?: "Remote voice request failed"
                    )
                }

                val transcription = response.optJSONObject("transcription")
                    ?.stringOrNull("text")
                    .orEmpty()
                val reply = response.stringOrNull("reply").orEmpty()
                val replyAudioBase64 = response.optJSONObject("reply_audio")
                    ?.stringOrNull("base64")
                    .orEmpty()

                if (replyAudioBase64.isNotBlank()) {
                    val replyAudio = android.util.Base64.decode(
                        replyAudioBase64,
                        android.util.Base64.DEFAULT
                    )
                    audioRecorder.playWav(replyAudio)
                }

                val completionMessage = when {
                    reply.isNotBlank() && transcription.isNotBlank() ->
                        "Heard: " + transcription + " | Floki: " + reply
                    reply.isNotBlank() -> reply
                    transcription.isNotBlank() -> "Heard: " + transcription
                    else -> "Voice request completed"
                }

                _state.update {
                    it.copy(
                        recording = false,
                        busyAction = null,
                        message = completionMessage,
                        error = null
                    )
                }
                refresh()
            } catch (error: kotlinx.coroutines.CancellationException) {
                _state.update {
                    it.copy(
                        recording = false,
                        busyAction = null,
                        message = "Voice recording cancelled"
                    )
                }
                throw error
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        recording = false,
                        busyAction = null,
                        error = error.message ?: "Voice request failed"
                    )
                }
            } finally {
                voiceJob = null
            }
        }
    }

    fun startVoiceRecording() = sendVoice()

    fun stopVoiceRecording() {
        voiceJob?.cancel()
        voiceJob = null
        _state.update {
            it.copy(
                recording = false,
                busyAction = null,
                message = "Voice recording cancelled"
            )
        }
    }

    fun control(action: String) {
        runAction(action) {
            val response = backend.post("/interface/control/$action")
            response.stringOrNull("message") ?: "$action accepted"
        }
    }

    fun controlModule(moduleKey: String, action: String) {
        val cleanModule = moduleKey.trim()
        val cleanAction = if (action == "restart") "reset" else action.trim()
        if (!MODULE_ACTIONS.contains(cleanAction)) {
            setError("Unknown module action")
            return
        }
        if (cleanModule.isBlank()) {
            setError("Unknown module")
            return
        }
        runAction("$cleanModule:$cleanAction") {
            val response = backend.post("/control/modules/$cleanModule/$cleanAction")
            if (cleanModule == MOBILE_APP_KEY && cleanAction in setOf("start", "reset")) {
                normalMobileTransportEnabled = true
                sendMobileHeartbeat()
                restartTransport()
            }
            response.stringOrNull("message") ?: "$cleanModule $cleanAction accepted"
        }
    }

    fun requestNap() = control("requestSleep")
    fun wake() = control("wake")

    fun approveCandidate(id: String) {
        runAction("approve") {
            val response = backend.post(
                "/self-improvement/approve",
                JSONObject().put("id", id)
            )
            response.stringOrNull("message") ?: "Candidate approval accepted"
        }
    }

    fun denyCandidate(id: String, reason: String) {
        val cleanReason = reason.trim()
        if (cleanReason.isBlank()) {
            setError("A denial reason is required")
            return
        }
        runAction("deny") {
            val response = backend.post(
                "/self-improvement/deny",
                JSONObject()
                    .put("id", id)
                    .put("reason", cleanReason)
            )
            response.stringOrNull("message") ?: "Candidate denied"
        }
    }

    fun pauseRsi() = authenticatedAction("pause", "/self-improvement/pause")
    fun resumeRsi() = authenticatedAction("resume", "/self-improvement/resume")

    fun runRsi(objective: String) {
        val body = JSONObject()
        val cleanObjective = objective.trim()
        if (cleanObjective.isNotBlank()) body.put("objective", cleanObjective)

        runAction("run-now") {
            val response = backend.post("/self-improvement/run-now", body)
            if (response.booleanOrNull("ok") == false) {
                throw IllegalStateException(
                    response.stringOrNull("error") ?: "RSI run failed"
                )
            }
            response.stringOrNull("message") ?: "RSI cycle started"
        }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null, error = null) }
    }

    private fun authenticatedAction(label: String, path: String) {
        runAction(label) {
            val response = backend.post(path)
            response.stringOrNull("message") ?: "$label accepted"
        }
    }

    fun logout() {
        profile = profile.copy(sessionCredential = "")
        profileStore.save(profile)
        profile = profileStore.load()
        _state.update {
            it.copy(
                profile = profile,
                message = "Session credential cleared",
                error = null
            )
        }
        restartTransport()
    }

    private fun runAction(name: String, block: suspend () -> String) {
        viewModelScope.launch {
            _state.update {
                it.copy(busyAction = name, error = null, message = null)
            }
            try {
                val message = block()
                _state.update { it.copy(busyAction = null, message = message) }
                refresh()
                refreshRsiTerminal()
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        busyAction = null,
                        error = error.message ?: "$name failed"
                    )
                }
            }
        }
    }

    private fun setError(message: String) {
        _state.update { it.copy(error = message, message = null) }
    }

    private fun String.isLoopbackHost(): Boolean =
        equals("127.0.0.1", ignoreCase = true) ||
            equals("localhost", ignoreCase = true)

    private fun restartTransport() {
        transportGeneration += 1
        val generation = transportGeneration

        reconnectJob?.cancel()
        pollingJob?.cancel()
        heartbeatJob?.cancel()
        terminalPollingJob?.cancel()
        visionPollingJob?.cancel()
        socket?.close(1000, "profile changed")
        backend.close()

        backend = FlokiBackend(profile)
        terminalCursor = 0L
        terminalGeneration = 0L
        _state.update {
            it.copy(
                profile = profile,
                connected = false,
                websocketConnected = false,
                rsiTerminalText = "",
                rsiTerminalError = null
            )
        }

        startMobileHeartbeat(generation)
        if (normalMobileTransportEnabled) connectSocket(generation)

        pollingJob = viewModelScope.launch {
            while (isActive && generation == transportGeneration) {
                delay(profile.pollIntervalMs)
                refresh()
            }
        }

        if (normalMobileTransportEnabled) {
            terminalPollingJob = viewModelScope.launch {
                while (isActive && generation == transportGeneration) {
                    delay(2_000L)
                    refreshRsiTerminal()
                }
            }

            visionPollingJob = viewModelScope.launch {
                while (isActive && generation == transportGeneration) {
                    delay(500L)
                    refreshVisionFrame()
                }
            }
        }
    }

    private fun startMobileHeartbeat(generation: Int) {
        heartbeatJob = viewModelScope.launch {
            while (isActive && generation == transportGeneration) {
                runCatching { sendMobileHeartbeat() }
                delay(5_000L)
            }
        }
    }

    private suspend fun sendMobileHeartbeat() {
        backend.post(
            "/interface/client-app/heartbeat",
            JSONObject()
                .put("app_key", MOBILE_APP_KEY)
                .put("client_id", mobileClientId)
                .put("session_id", mobileSessionId)
                .put("transport_type", "android-http")
                .put("healthy", true)
        )
    }

    private fun stopNormalMobileTraffic() {
        reconnectJob?.cancel()
        terminalPollingJob?.cancel()
        visionPollingJob?.cancel()
        voiceJob?.cancel()
        socket?.close(1000, "mobile_app stopped")
        socket = null
        _state.update {
            it.copy(
                websocketConnected = false,
                recording = false,
                busyAction = null
            )
        }
    }

    private fun applyMobileServiceControl(service: ServiceItem) {
        val nextGeneration = service.controlGeneration
        val generationChanged = nextGeneration != null &&
            observedMobileGeneration != null &&
            nextGeneration != observedMobileGeneration
        if (nextGeneration != null) observedMobileGeneration = nextGeneration
        if (!service.enabled || service.lifecycleState.lowercase() == "stopped") {
            if (normalMobileTransportEnabled) {
                normalMobileTransportEnabled = false
                stopNormalMobileTraffic()
            }
            return
        }
        if (!normalMobileTransportEnabled || generationChanged) {
            normalMobileTransportEnabled = true
            restartTransport()
        }
    }

    private fun connectSocket(generation: Int) {
        if (generation != transportGeneration) return
        socket = backend.openEvents(
            onOpen = {
                viewModelScope.launch {
                    if (generation == transportGeneration) {
                        _state.update { it.copy(websocketConnected = true) }
                    }
                }
            },
            onMessage = {
                if (generation == transportGeneration) {
                    refresh()
                    refreshRsiTerminal()
                }
            },
            onFailure = { message ->
                viewModelScope.launch {
                    if (generation == transportGeneration) {
                        _state.update {
                            it.copy(
                                websocketConnected = false,
                                error = message
                            )
                        }
                        scheduleSocketReconnect(generation)
                    }
                }
            },
            onClosed = {
                viewModelScope.launch {
                    if (generation == transportGeneration) {
                        _state.update { it.copy(websocketConnected = false) }
                        scheduleSocketReconnect(generation)
                    }
                }
            }
        )
    }

    private fun scheduleSocketReconnect(generation: Int) {
        if (generation != transportGeneration || reconnectJob?.isActive == true) return
        reconnectJob = viewModelScope.launch {
            delay(3_000L)
            if (generation == transportGeneration) connectSocket(generation)
        }
    }

    override fun onCleared() {
        reconnectJob?.cancel()
        pollingJob?.cancel()
        heartbeatJob?.cancel()
        terminalPollingJob?.cancel()
        visionPollingJob?.cancel()
        voiceJob?.cancel()
        socket?.close(1000, "app closing")
        backend.close()
    }

    private fun parseRuntime(json: JSONObject): RuntimeSnapshot = RuntimeSnapshot(
        state = json.stringOrNull("state") ?: "unknown",
        mode = json.stringOrNull("mode") ?: "chat.local",
        model = json.stringOrNull("cognitionModel") ?: "unknown",
        online = json.booleanOrNull("online") == true,
        ready = json.booleanOrNull("fullyReady") == true,
        vision = json.booleanOrNull("visionActive") == true,
        hearing = json.booleanOrNull("hearingActive") == true,
        memory = json.booleanOrNull("memoryLoaded") == true,
        speech = json.booleanOrNull("speechActive") == true
    )

    private fun parseServices(array: JSONArray): List<ServiceItem> = buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            add(
                    ServiceItem(
                        key = item.stringOrNull("key") ?: item.stringOrNull("name") ?: "unknown",
                        name = item.stringOrNull("name") ?: "Unknown service",
                        status = item.stringOrNull("status") ?: "Unknown",
                        lifecycleState = item.stringOrNull("lifecycleState") ?: "unknown",
                        detail = item.stringOrNull("detail") ?: "",
                        lastError = item.stringOrNull("lastError"),
                        clientApp = item.booleanOrNull("clientApp") == true,
                        enabled = item.booleanOrNull("enabled") != false,
                        startAvailable = item.booleanOrNull("startAvailable") == true,
                        stopAvailable = item.booleanOrNull("stopAvailable") == true,
                        resetAvailable = item.booleanOrNull("resetAvailable") == true,
                        connectedClientCount = item.intOrNull("connectedClientCount"),
                        healthyClientCount = item.intOrNull("healthyClientCount"),
                        transportType = item.stringOrNull("transportType"),
                        controlGeneration = item.longOrNull("controlGeneration")
                    )
                )
        }
    }

    private fun parseChat(array: JSONArray): List<ChatMessage> = buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val content = item.stringOrNull("content") ?: continue
            add(
                ChatMessage(
                    id = item.stringOrNull("id") ?: "chat-$index",
                    role = item.stringOrNull("role") ?: "unknown",
                    content = content,
                    timestamp = item.longOrNull("timestamp") ?: 0L,
                    partial = item.booleanOrNull("isPartial") == true
                )
            )
        }
    }

    private fun parseDreams(root: JSONObject): List<DreamItem> {
        val array = root.optJSONArray("dreams") ?: JSONArray()
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                add(
                    DreamItem(
                        id = item.stringOrNull("id") ?: "dream-$index",
                        title = item.stringOrNull("title") ?: "Untitled dream",
                        story = item.stringOrNull("story")
                            ?: item.stringOrNull("transcript")
                            ?: "",
                        remCycle = item.intOrNull("remCycleNumber"),
                        timestamp = item.longOrNull("timestamp") ?: 0L
                    )
                )
            }
        }
    }

    private fun parseNeural(array: JSONArray): List<NeuralItem> = buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            add(
                NeuralItem(
                    id = item.stringOrNull("id") ?: "neural-$index",
                    module = item.stringOrNull("module")
                        ?: item.stringOrNull("category")
                        ?: "reflection",
                    summary = item.stringOrNull("summary") ?: continue,
                    timestamp = item.longOrNull("timestamp") ?: 0L
                )
            )
        }
    }

    private fun parseSleep(json: JSONObject): SleepSnapshot {
        val raw = json.optJSONObject("raw")
        val manualNap = json.optJSONObject("manualNap")
        return SleepSnapshot(
            state = json.stringOrNull("state") ?: "unknown",
            currentRemCycle = json.intOrNull("currentRemCycle")?.takeIf { it > 0 },
            remainingMs = manualNap?.longOrNull("remaining_ms")
                ?: raw?.longOrNull("sleep_remaining_ms"),
            nextRemCountdownMs = manualNap?.longOrNull("next_rem_countdown_ms")
                ?: raw?.longOrNull("next_rem_countdown_ms"),
            completedRemCycles = manualNap?.intOrNull("completed_rem_cycles")
                ?: raw?.intOrNull("completed_rem_cycles"),
            totalRemCycles = manualNap?.intOrNull("total_rem_cycles")
                ?: raw?.intOrNull("total_rem_cycles"),
            dreaming = json.booleanOrNull("dreaming") == true ||
                json.booleanOrNull("remActive") == true
        )
    }

    private fun parseRsi(root: JSONObject): RsiSnapshot {
        val status = root.optJSONObject("status") ?: root
        return RsiSnapshot(
            phase = status.stringOrNull("phase")
                ?: status.stringOrNull("state")
                ?: "unknown",
            state = status.stringOrNull("state") ?: "unknown",
            paused = status.booleanOrNull("paused") == true,
            workerRunning = status.booleanOrNull("worker_running") == true,
            modelProxyReady = status.booleanOrNull("model_proxy_ready") == true,
            currentRunId = status.stringOrNull("current_run_id"),
            currentContainer = status.stringOrNull("current_container"),
            lastError = status.stringOrNull("last_error")
        )
    }

    private fun parseCandidates(root: JSONObject): List<CandidateItem> {
        val array = root.optJSONArray("candidates") ?: JSONArray()
        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val id = item.stringOrNull("id") ?: continue
                add(
                    CandidateItem(
                        id = id,
                        status = item.stringOrNull("status") ?: "unknown",
                        objective = item.stringOrNull("objective")
                            ?: "No objective provided",
                        riskLevel = item.stringOrNull("risk_level") ?: "unknown",
                        summary = item.stringOrNull("summary_markdown") ?: "",
                        createdAt = parseTimestamp(item.stringOrNull("created_at"))
                    )
                )
            }
        }
    }

    private fun parseTimestamp(value: String?): Long {
        if (value.isNullOrBlank()) return 0L
        return runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(0L)
    }

    private companion object {
        const val MOBILE_APP_KEY = "mobile_app"
        val MODULE_ACTIONS = setOf("start", "stop", "reset")
    }
}
