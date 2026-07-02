package com.floki.neural.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.floki.neural.data.FlokiBackend
import com.floki.neural.data.ProfileStore
import com.floki.neural.data.ServerProfile
import com.floki.neural.data.booleanOrNull
import com.floki.neural.data.intOrNull
import com.floki.neural.data.longOrNull
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
import java.util.concurrent.atomic.AtomicBoolean

private const val RSI_ACTIVITY_LIMIT = 3_000

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
    val name: String,
    val status: String,
    val detail: String,
    val lastError: String?
)

data class CandidateItem(
    val id: String,
    val status: String,
    val objective: String,
    val riskLevel: String,
    val summary: String,
    val createdAt: Long
)

data class RsiActivityItem(
    val id: String,
    val source: String,
    val type: String,
    val text: String,
    val timestamp: Long
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
    val rsiActivity: List<RsiActivityItem> = emptyList(),
    val rsiTerminalError: String? = null,
    val visionFrameBytes: ByteArray? = null,
    val visionFrameGeneration: Int = 0,
    val message: String? = null,
    val error: String? = null
)

class FlokiViewModel(application: Application) : AndroidViewModel(application) {
    private val profileStore = ProfileStore(application.applicationContext)
    private var profile = profileStore.load()
    private var backend = FlokiBackend(profile)
    private var socket: WebSocket? = null
    private var pollingJob: Job? = null
    private var activityPollingJob: Job? = null
    private var visionPollingJob: Job? = null
    private var reconnectJob: Job? = null
    private var transportGeneration = 0

    private var auditCursor = 0L
    private var sandboxCursor = 0L
    private var sandboxLogFile: String? = null

    private val refreshInProgress = AtomicBoolean(false)
    private val activityRefreshInProgress = AtomicBoolean(false)

    private val _state = MutableStateFlow(FlokiUiState(profile = profile))
    val state: StateFlow<FlokiUiState> = _state.asStateFlow()

    init {
        restartTransport()
        refresh()
        refreshRsiActivity(reset = true)
    }

    fun saveProfile(
        host: String,
        portText: String,
        pollText: String,
        token: String,
        useTls: Boolean
    ) {
        val cleanHost = host.trim()
            .removePrefix("https://")
            .removePrefix("http://")
            .trimEnd('/')
        val port = portText.toIntOrNull()
        val poll = pollText.toLongOrNull()

        when {
            cleanHost.isBlank() -> setError("Server host cannot be empty")
            cleanHost.contains('/') -> setError("Server host must not include a path")
            port == null || port !in 1..65535 -> setError("Port must be between 1 and 65535")
            poll == null || poll !in 1_000L..60_000L -> setError(
                "Poll interval must be between 1000 and 60000 ms"
            )
            else -> {
                profile = ServerProfile(
                    host = cleanHost,
                    port = port,
                    pollIntervalMs = poll,
                    rsiApprovalToken = token.trim(),
                    useTls = useTls
                )
                profileStore.save(profile)
                _state.update {
                    it.copy(
                        profile = profile,
                        message = "Connection profile saved",
                        error = null
                    )
                }
                restartTransport()
                refresh()
                refreshRsiActivity(reset = true)
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
                val transcriptResult = runCatching {
                    backend.getArray("/interface/transcript?limit=200")
                }
                val dreamsResult = runCatching { backend.getObject("/interface/dreams") }
                val neuralResult = runCatching {
                    backend.getArray("/interface/neural?limit=250")
                }
                val sleepResult = runCatching { backend.getObject("/interface/sleep") }
                val rsiResult = runCatching { backend.getObject("/self-improvement/status") }
                val candidatesResult = runCatching {
                    backend.getObject("/self-improvement/candidates")
                }

                _state.update { current ->
                    current.copy(
                        connected = true,
                        runtime = parseRuntime(status),
                        services = servicesResult.getOrNull()?.let(::parseServices)
                            ?: current.services,
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

    fun refreshRsiActivity(reset: Boolean = false) {
        if (reset) {
            auditCursor = 0L
            sandboxCursor = 0L
            sandboxLogFile = null
            _state.update { it.copy(rsiActivity = emptyList(), rsiTerminalError = null) }
        }
        if (!activityRefreshInProgress.compareAndSet(false, true)) return

        viewModelScope.launch {
            try {
                val result = backend.getObject(
                    "/self-improvement/activity" +
                        "?audit_cursor=$auditCursor" +
                        "&sandbox_cursor=$sandboxCursor" +
                        "&limit=200"
                )
                if (result.booleanOrNull("ok") == false) {
                    throw IllegalStateException(
                        result.stringOrNull("error") ?: "RSI activity request failed"
                    )
                }

                val nextSandboxFile = result.stringOrNull("sandbox_log_file")
                val newRunStarted = sandboxLogFile != null &&
                    nextSandboxFile != null &&
                    nextSandboxFile != sandboxLogFile

                sandboxLogFile = nextSandboxFile
                auditCursor = result.longOrNull("next_audit_cursor") ?: auditCursor
                sandboxCursor = result.longOrNull("next_sandbox_cursor") ?: sandboxCursor

                val incoming = parseRsiActivity(result.optJSONArray("events") ?: JSONArray())
                _state.update { current ->
                    val base = if (newRunStarted) emptyList() else current.rsiActivity
                    val merged = (base + incoming)
                        .distinctBy { it.id }
                        .takeLast(RSI_ACTIVITY_LIMIT)
                    current.copy(
                        rsiActivity = merged,
                        rsiTerminalError = null
                    )
                }
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        rsiTerminalError = error.message ?: "RSI terminal disconnected"
                    )
                }
            } finally {
                activityRefreshInProgress.set(false)
            }
        }
    }

    fun flushVisionFrame() {
        _state.update { it.copy(visionFrameBytes = null) }
    }

    fun refreshVisionFrame() {
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
        val value = text.trim()
        if (value.isBlank()) return
        runAction("chat") {
            backend.post("/chat", JSONObject().put("text", value))
            "Message sent"
        }
    }

    fun control(action: String) {
        runAction(action) {
            val response = backend.post("/interface/control/$action")
            response.stringOrNull("message") ?: "$action accepted"
        }
    }

    fun requestNap() = control("requestSleep")
    fun wake() = control("wake")

    fun approveCandidate(id: String) {
        val token = requireRsiToken() ?: return
        runAction("approve") {
            val response = backend.post(
                "/self-improvement/approve",
                JSONObject().put("id", id).put("token", token)
            )
            response.stringOrNull("message") ?: "Candidate approval accepted"
        }
    }

    fun denyCandidate(id: String, reason: String) {
        val token = requireRsiToken() ?: return
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
                    .put("token", token)
                    .put("reason", cleanReason)
            )
            response.stringOrNull("message") ?: "Candidate denied"
        }
    }

    fun pauseRsi() = tokenAction("pause", "/self-improvement/pause")
    fun resumeRsi() = tokenAction("resume", "/self-improvement/resume")

    fun runRsi(objective: String) {
        val token = requireRsiToken() ?: return
        val body = JSONObject().put("token", token)
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

    private fun tokenAction(label: String, path: String) {
        val token = requireRsiToken() ?: return
        runAction(label) {
            val response = backend.post(path, JSONObject().put("token", token))
            response.stringOrNull("message") ?: "$label accepted"
        }
    }

    private fun requireRsiToken(): String? {
        val token = profile.rsiApprovalToken.trim()
        if (token.isBlank()) {
            setError(
                "Add the RSI approval token in Settings before using privileged RSI controls"
            )
            return null
        }
        return token
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
                refreshRsiActivity()
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

    private fun restartTransport() {
        transportGeneration += 1
        val generation = transportGeneration

        reconnectJob?.cancel()
        pollingJob?.cancel()
        activityPollingJob?.cancel()
        visionPollingJob?.cancel()
        socket?.close(1000, "profile changed")
        backend.close()

        backend = FlokiBackend(profile)
        auditCursor = 0L
        sandboxCursor = 0L
        sandboxLogFile = null
        _state.update {
            it.copy(
                profile = profile,
                connected = false,
                websocketConnected = false,
                rsiActivity = emptyList(),
                rsiTerminalError = null
            )
        }

        connectSocket(generation)

        pollingJob = viewModelScope.launch {
            while (isActive && generation == transportGeneration) {
                delay(profile.pollIntervalMs)
                refresh()
            }
        }

        activityPollingJob = viewModelScope.launch {
            while (isActive && generation == transportGeneration) {
                delay(2_000L)
                refreshRsiActivity()
            }
        }

        visionPollingJob = viewModelScope.launch {
            while (isActive && generation == transportGeneration) {
                delay(500L)
                refreshVisionFrame()
            }
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
                    refreshRsiActivity()
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
        activityPollingJob?.cancel()
        visionPollingJob?.cancel()
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
                    name = item.stringOrNull("name") ?: "Unknown service",
                    status = item.stringOrNull("status") ?: "Unknown",
                    detail = item.stringOrNull("detail") ?: "",
                    lastError = item.stringOrNull("lastError")
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

    private fun parseRsiActivity(array: JSONArray): List<RsiActivityItem> = buildList {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val source = item.stringOrNull("source") ?: "activity"
            val offset = item.longOrNull("index") ?: index.toLong()
            val record = item.optJSONObject("record") ?: continue
            val type = record.stringOrNull("type") ?: "event"
            val detail = record.optJSONObject("detail") ?: JSONObject()
            val timestamp = parseTimestamp(record.stringOrNull("created_at"))
            add(
                RsiActivityItem(
                    id = "$source-$offset",
                    source = source,
                    type = type,
                    text = activityText(type, detail, record),
                    timestamp = timestamp
                )
            )
        }
    }

    private fun activityText(
        type: String,
        detail: JSONObject,
        record: JSONObject
    ): String = when (type) {
        "shell_end" -> {
            val command = detail.stringOrNull("command")
                ?: detail.stringOrNull("identity")
                ?: "shell command"
            val status = detail.intOrNull("status")
            val output = detail.stringOrNull("stderr")
                ?: detail.stringOrNull("stdout")
                ?: ""
            buildString {
                append("$ ")
                append(command)
                if (status != null) append(" → exit $status")
                if (output.isNotBlank()) {
                    append('\n')
                    append(output.take(4_000))
                }
            }
        }
        "shell_progress" -> {
            val command = detail.stringOrNull("command")
                ?: detail.stringOrNull("identity")
                ?: "shell command"
            "$ $command …"
        }
        "write_file" -> "write ${detail.stringOrNull("path") ?: "file"}"
        "apply_patch" -> "patch ${detail.stringOrNull("path") ?: "workspace"}"
        "experiment_selected" -> detail.optJSONObject("experiment")
            ?.stringOrNull("objective")
            ?.let { "selected: $it" }
            ?: "experiment selected"
        "candidate_finalized",
        "candidate_auto_finalized_after_verification" ->
            "candidate ready: ${detail.stringOrNull("objective") ?: "review required"}"
        "candidate_denied_by_maker" ->
            "denied: ${detail.stringOrNull("reason") ?: "no reason recorded"}"
        "candidate_approved_by_maker" ->
            "approved: ${detail.stringOrNull("candidate_id") ?: "candidate"}"
        "cycle_failed", "fatal" ->
            detail.stringOrNull("error") ?: detail.stringOrNull("reason") ?: type
        else -> {
            val summary = detail.stringOrNull("summary")
                ?: detail.stringOrNull("reason")
                ?: detail.stringOrNull("objective")
            summary?.let { "$type: $it" } ?: record.toString().take(4_000)
        }
    }

    private fun parseTimestamp(value: String?): Long {
        if (value.isNullOrBlank()) return 0L
        return runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(0L)
    }
}
