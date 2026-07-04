package com.floki.neural.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.floki.neural.data.FlokiBackend
import com.floki.neural.data.FlokiUnauthorizedException
import com.floki.neural.data.MobileBootstrapAuth
import com.floki.neural.data.MobileBootstrapSession
import com.floki.neural.data.FlokiAudioRecorder
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
    val controlGeneration: Long? = null,
    val logAvailable: Boolean = false,
    val logKey: String? = null
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
    val currentObjective: String? = null,
    val activeRole: String? = null,
    val activeTool: String? = null,
    val resourceMode: String? = null,
    val gpuOwner: String? = null,
    val gpuWorkloadOwner: String? = null,
    val telemetryStale: Boolean = false,
    val lastError: String? = null
)

data class SessionSnapshot(
    val signedIn: Boolean = false,
    val account: String? = null,
    val role: String? = null,
    val status: String? = null,
    val expiresAt: Long? = null,
    val capabilities: Set<String> = emptySet(),
    val lastError: String? = null
) {
    fun has(capability: String): Boolean = signedIn && capabilities.contains(capability)
}

data class VisionDetection(
    val id: String,
    val kind: String,
    val label: String,
    val confidence: Float?,
    val x: Float,
    val y: Float,
    val width: Float,
    val height: Float
)

data class VisionOverlaySnapshot(
    val detections: List<VisionDetection> = emptyList(),
    val frameWidth: Int = 0,
    val frameHeight: Int = 0,
    val frameRate: Double = 0.0,
    val connectionStatus: String = "offline",
    val frameFresh: Boolean = false,
    val detectionFresh: Boolean = false,
    val updatedAt: Long = 0L
)

data class FlokiUiState(
    val profile: ServerProfile = ServerProfile(),
    val connected: Boolean = false,
    val websocketConnected: Boolean = false,
    val session: SessionSnapshot = SessionSnapshot(),
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
    val logWorkspaceTitle: String? = null,
    val logWorkspaceService: String = "",
    val logWorkspaceText: String = "",
    val logWorkspaceLoading: Boolean = false,
    val visionFrameBytes: ByteArray? = null,
    val visionFrameGeneration: Int = 0,
    val visionOverlay: VisionOverlaySnapshot =
        VisionOverlaySnapshot(),
    val visionTransportState: String = "waiting",
    val visionTransportFailures: Int = 0,
    val recording: Boolean = false,
    val hasAudioPermission: Boolean = false,
    val message: String? = null,
    val error: String? = null
) {
    /**
     * Truthful connection state derived from real traffic outcomes, never
     * from cached data alone.
     */
    val connectionState: String
        get() = when {
            profile.sessionCredential.isBlank() && !profile.developerMode -> "Signed out"
            connected -> "Connected"
            error?.contains("Unauthorized", ignoreCase = true) == true -> "Unauthorized"
            refreshing -> "Connecting"
            else -> "Offline"
        }
}

class FlokiViewModel(application: Application) : AndroidViewModel(application) {
    private val profileStore = ProfileStore(application.applicationContext)
    private val audioRecorder = FlokiAudioRecorder()
    private var profile = profileStore.load()
    private val mobileBootstrapAuth = MobileBootstrapAuth()
    private var accessCredential = ""
    private var accessExpiresAtMs = 0L
    private var backend = FlokiBackend(
        profile,
        accessCredential
    )
    private var socket: WebSocket? = null
    private var pollingJob: Job? = null
    private var heartbeatJob: Job? = null
    private var terminalPollingJob: Job? = null
    private var visionPollingJob: Job? = null
    private var reconnectJob: Job? = null
    private var voiceJob: Job? = null
    private var bootstrapJob: Job? = null
    private var tokenRefreshJob: Job? = null
    private var transportGeneration = 0
    private val mobileClientId = profileStore.loadOrCreateMobileClientId()
    private val mobileSessionId = "mobile-session-${UUID.randomUUID()}"
    private var normalMobileTransportEnabled = true
    private var observedMobileGeneration: Long? = null

    private var terminalCursor = 0L
    private var terminalGeneration = 0L

    private val refreshInProgress = AtomicBoolean(false)
    private val terminalRefreshInProgress = AtomicBoolean(false)
    private val visionFrameRequestInProgress =
        AtomicBoolean(false)
    private val visionMetadataRequestInProgress =
        AtomicBoolean(false)
    private var visionLastGoodFrameAtMs = 0L
    private var visionConsecutiveFrameFailures = 0
    private var visionAuthoritativeOfflineCount = 0

    private val _state = MutableStateFlow(FlokiUiState(profile = profile))
    val state: StateFlow<FlokiUiState> = _state.asStateFlow()

    init {
        if (profile.developerMode) {
            accessExpiresAtMs = Long.MAX_VALUE
            restartTransport()
            refresh()
            refreshRsiTerminal(reset = true)
        } else {
            bootstrapAndStart()
        }
    }

    fun saveProfile(
        host: String,
        portText: String,
        pollText: String,
        useTls: Boolean,
        developerMode: Boolean
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
            !developerMode && cleanHost.isLoopbackHost() -> setError(
                "Loopback profiles require Developer local profile"
            )
            port == null || port !in 1..65535 -> setError("Port must be between 1 and 65535")
            poll == null || poll !in 1_000L..60_000L -> setError(
                "Poll interval must be between 1000 and 60000 ms"
            )
            else -> {
                profile = ServerProfile(
                    host = cleanHost,
                    port = port,
                    pollIntervalMs = poll,
                    sessionCredential = "",
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
                if (profile.developerMode) {
                    accessCredential = ""
                    accessExpiresAtMs = Long.MAX_VALUE
                    restartTransport()
                    refresh()
                    refreshRsiTerminal(reset = true)
                } else {
                    accessCredential = ""
                    accessExpiresAtMs = 0L
                    bootstrapAndStart(force = true)
                }
            }
        }
    }

    fun reconnectAutomaticAccess() {
        if (profile.developerMode) {
            restartTransport()
            refresh()
            return
        }
        bootstrapAndStart(force = true)
    }

    private fun bootstrapAndStart(
        force: Boolean = false
    ) {
        if (profile.developerMode) {
            accessCredential = ""
            accessExpiresAtMs = Long.MAX_VALUE
            restartTransport()
            refresh()
            return
        }

        if (
            bootstrapJob?.isActive == true &&
            !force
        ) {
            return
        }

        if (force) {
            bootstrapJob?.cancel()
            bootstrapJob = null
        }

        bootstrapJob = viewModelScope.launch {
            var attempt = 0
            try {
                while (isActive) {
                    val hasUsableCredential =
                        accessCredential.isNotBlank() &&
                            System.currentTimeMillis() +
                                5_000L <
                                accessExpiresAtMs

                    _state.update {
                        it.copy(
                            connected =
                                if (hasUsableCredential) {
                                    it.connected
                                } else {
                                    false
                                },
                            websocketConnected =
                                if (hasUsableCredential) {
                                    it.websocketConnected
                                } else {
                                    false
                                },
                            message =
                                if (attempt == 0) {
                                    "Authorizing this host-built APK…"
                                } else {
                                    "Reconnecting automatic access…"
                                },
                            error = null
                        )
                    }

                    try {
                        val session =
                            mobileBootstrapAuth.requestSession(
                                mobileClientId
                            )
                        applyBootstrapSession(session)
                        return@launch
                    } catch (
                        error:
                            kotlinx.coroutines.CancellationException
                    ) {
                        throw error
                    } catch (_: Exception) {
                        attempt += 1

                        if (!hasUsableCredential) {
                            accessCredential = ""
                            accessExpiresAtMs = 0L
                            stopAllTransport()
                        }

                        _state.update {
                            it.copy(
                                connected =
                                    if (hasUsableCredential) {
                                        it.connected
                                    } else {
                                        false
                                    },
                                websocketConnected =
                                    if (hasUsableCredential) {
                                        it.websocketConnected
                                    } else {
                                        false
                                    },
                                message =
                                    "Reconnecting automatic access…",
                                error = null
                            )
                        }

                        val retryDelay = (
                            AUTO_ACCESS_RETRY_BASE_MS *
                                attempt.coerceAtMost(15)
                        ).coerceAtMost(
                            AUTO_ACCESS_RETRY_MAX_MS
                        )
                        delay(retryDelay)
                    }
                }
            } finally {
                bootstrapJob = null
            }
        }
    }

    private suspend fun applyBootstrapSession(
        session: MobileBootstrapSession
    ) {
        accessCredential = session.accessToken
        accessExpiresAtMs =
            System.currentTimeMillis() +
                session.expiresInSeconds * 1_000L
        backend.close()
        backend = FlokiBackend(
            profile,
            accessCredential
        )

        val gatewaySession = parseSession(
            backend.getSession()
        )
        val missingCapabilities =
            FULL_HOST_CAPABILITIES.filterNot(
                gatewaySession::has
            )

        if (
            !gatewaySession.signedIn ||
            gatewaySession.role?.lowercase() !in
                setOf("admin", "administrator") ||
            gatewaySession.status?.lowercase() != "approved" ||
            missingCapabilities.isNotEmpty()
        ) {
            accessCredential = ""
            accessExpiresAtMs = 0L
            backend.close()
            throw IllegalStateException(
                "Host-authorized APK did not receive full control capabilities" +
                    if (missingCapabilities.isEmpty()) {
                        ""
                    } else {
                        ": " + missingCapabilities.sorted().joinToString(", ")
                    }
            )
        }

        _state.update {
            it.copy(
                session = gatewaySession,
                message = "Host-authorized APK connected with full control",
                error = null
            )
        }

        restartTransport()
        refresh()
        refreshRsiTerminal(reset = true)
    }

    private fun recoverUnauthorized() {
        if (
            profile.developerMode ||
            bootstrapJob?.isActive == true
        ) {
            return
        }

        accessCredential = ""
        accessExpiresAtMs = 0L
        stopAllTransport()
        _state.update {
            it.copy(
                connected = false,
                websocketConnected = false,
                message = "Renewing automatic access…",
                error = null
            )
        }
        bootstrapAndStart()
    }

    private fun stopAllTransport() {
        reconnectJob?.cancel()
        pollingJob?.cancel()
        heartbeatJob?.cancel()
        tokenRefreshJob?.cancel()
        terminalPollingJob?.cancel()
        visionPollingJob?.cancel()
        voiceJob?.cancel()
        socket?.close(
            1000,
            "host authorization unavailable"
        )
        socket = null
        backend.close()
    }

    fun refresh() {
        if (!refreshInProgress.compareAndSet(false, true)) return
        viewModelScope.launch {
            _state.update { it.copy(refreshing = true) }
            try {
                val status = backend.getObject("/interface/status")
                val sessionResult = runCatching {
                    if (
                        profile.developerMode ||
                        accessCredential.isNotBlank()
                    ) {
                        backend.getSession()
                    } else {
                        null
                    }
                }
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
                        session = sessionResult.fold(
                            onSuccess = { json ->
                                json?.let(::parseSession) ?: SessionSnapshot()
                            },
                            onFailure = { error ->
                                current.session.copy(
                                    lastError = error.message
                                )
                            }
                        ),
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
                val detail =
                    error.message.orEmpty()
                val authorizationFailure =
                    error is FlokiUnauthorizedException
                val transientTransportFailure =
                    detail.contains(
                        "unable to resolve host",
                        ignoreCase = true
                    ) ||
                        detail.contains(
                            "timeout",
                            ignoreCase = true
                        ) ||
                        detail.contains(
                            "failed to connect",
                            ignoreCase = true
                        )

                if (authorizationFailure) {
                    recoverUnauthorized()
                }

                _state.update {
                    it.copy(
                        connected = false,
                        refreshing = false,
                        message =
                            if (authorizationFailure) {
                                "Renewing automatic access…"
                            } else if (
                                transientTransportFailure
                            ) {
                                "Reconnecting secure transport…"
                            } else {
                                it.message
                            },
                        error =
                            if (
                                authorizationFailure ||
                                transientTransportFailure
                            ) {
                                null
                            } else {
                                detail.ifBlank {
                                    "Could not reach Floki-v2"
                                }
                            }
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
        visionLastGoodFrameAtMs = 0L
        visionConsecutiveFrameFailures = 0
        visionAuthoritativeOfflineCount = 0
        _state.update {
            it.copy(
                visionFrameBytes = null,
                visionOverlay = VisionOverlaySnapshot(),
                visionTransportState = "waiting",
                visionTransportFailures = 0
            )
        }
    }

    fun refreshVisionFrame() {
        if (!normalMobileTransportEnabled) return
        viewModelScope.launch {
            pollVisionFrameOnce()
            pollVisionMetadataOnce()
        }
    }

    private suspend fun pollVisionFrameOnce() {
        if (!normalMobileTransportEnabled) return
        if (!visionFrameRequestInProgress.compareAndSet(false, true)) return

        try {
            val bytes = backend.getVisionFrameBytes()
            visionLastGoodFrameAtMs = System.currentTimeMillis()
            visionConsecutiveFrameFailures = 0
            _state.update {
                it.copy(
                    visionFrameBytes = bytes,
                    visionFrameGeneration = it.visionFrameGeneration + 1,
                    visionTransportState = "live",
                    visionTransportFailures = 0
                )
            }
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: FlokiUnauthorizedException) {
            recoverUnauthorized()
        } catch (_: Exception) {
            visionConsecutiveFrameFailures += 1
            val hasLastGoodFrame = _state.value.visionFrameBytes != null
            _state.update {
                it.copy(
                    visionTransportState = if (hasLastGoodFrame) "reconnecting" else "waiting",
                    visionTransportFailures = visionConsecutiveFrameFailures
                )
            }
        } finally {
            visionFrameRequestInProgress.set(false)
        }
    }

    private suspend fun pollVisionMetadataOnce() {
        if (!normalMobileTransportEnabled) return
        if (!visionMetadataRequestInProgress.compareAndSet(false, true)) return

        try {
            val overlay = parseVisionOverlay(backend.getVisionMetadata())
            val authoritativeLive =
                overlay.connectionStatus == "active" && overlay.frameFresh

            if (authoritativeLive) {
                visionAuthoritativeOfflineCount = 0
                _state.update {
                    it.copy(
                        visionOverlay = overlay,
                        visionTransportState = if (it.visionFrameBytes != null) "live" else "waiting"
                    )
                }
            } else {
                visionAuthoritativeOfflineCount += 1
                val lastGoodAgeMs = System.currentTimeMillis() - visionLastGoodFrameAtMs
                val clearExpiredFrame =
                    visionAuthoritativeOfflineCount >= VISION_AUTHORITATIVE_OFFLINE_CONFIRMATIONS &&
                        lastGoodAgeMs > VISION_FRAME_GRACE_MS

                _state.update {
                    it.copy(
                        visionFrameBytes = if (clearExpiredFrame) null else it.visionFrameBytes,
                        visionOverlay = overlay.copy(detections = emptyList()),
                        visionTransportState = if (clearExpiredFrame) "waiting" else "reconnecting"
                    )
                }
            }
        } catch (error: kotlinx.coroutines.CancellationException) {
            throw error
        } catch (error: FlokiUnauthorizedException) {
            recoverUnauthorized()
        } catch (_: Exception) {
            // Transient metadata failures preserve the last good frame and boxes.
        } finally {
            visionMetadataRequestInProgress.set(false)
        }
    }

    private fun parseVisionOverlay(root: JSONObject): VisionOverlaySnapshot {
        val frame = root.optJSONObject("frame")
        val detection = root.optJSONObject("detection")
        val connectionStatus = root.stringOrNull("connectionStatus") ?: "offline"
        val frameFresh = frame?.booleanOrNull("fresh") == true
        val detectionFresh =
            connectionStatus == "active" &&
                frameFresh &&
                detection?.booleanOrNull("fresh") == true &&
                detection.booleanOrNull("stale") != true

        val detections = if (detectionFresh) {
            buildList {
                addAll(parseVisionDetectionArray(root.optJSONArray("objects"), "object"))
                addAll(parseVisionDetectionArray(root.optJSONArray("persons"), "person"))
                addAll(parseVisionDetectionArray(root.optJSONArray("faces"), "face"))
            }
        } else {
            emptyList()
        }

        return VisionOverlaySnapshot(
            detections = detections,
            frameWidth = frame?.intOrNull("width") ?: 0,
            frameHeight = frame?.intOrNull("height") ?: 0,
            frameRate = root.optDouble("frameRate", 0.0).takeIf { it.isFinite() } ?: 0.0,
            connectionStatus = connectionStatus,
            frameFresh = frameFresh,
            detectionFresh = detectionFresh,
            updatedAt = System.currentTimeMillis()
        )
    }

    private fun parseVisionDetectionArray(
        array: JSONArray?,
        kind: String
    ): List<VisionDetection> {
        if (array == null) return emptyList()

        return buildList {
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val box = item.optJSONObject("bbox") ?: continue
                val x = finiteFloat(box.opt("x")) ?: continue
                val y = finiteFloat(box.opt("y")) ?: continue
                val width = finiteFloat(box.opt("width")) ?: continue
                val height = finiteFloat(box.opt("height")) ?: continue

                if (
                    x < 0f || y < 0f || width <= 0f || height <= 0f ||
                    x > 1f || y > 1f || width > 1f || height > 1f ||
                    x + width > 1.001f || y + height > 1.001f
                ) continue

                val label =
                    item.stringOrNull("label")
                        ?: item.stringOrNull("class")
                        ?: item.stringOrNull("name")
                        ?: kind
                add(
                    VisionDetection(
                        id = item.stringOrNull("id") ?: "$kind-$index",
                        kind = kind,
                        label = label,
                        confidence = finiteFloat(item.opt("confidence"))?.coerceIn(0f, 1f),
                        x = x,
                        y = y,
                        width = width,
                        height = height
                    )
                )
            }
        }
    }

    private fun finiteFloat(value: Any?): Float? {
        val number = when (value) {
            is Number -> value.toFloat()
            is String -> value.toFloatOrNull()
            else -> null
        }
        return number?.takeIf { it.isFinite() }
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
        if (!requireCapability("system:control", "Module $cleanAction")) return
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

    /**
     * Server-side authorization is authoritative; this local gate exists so a
     * missing capability produces an actionable reason instead of a request
     * that is known to fail.
     */
    private fun requireCapability(
        capability: String,
        actionLabel: String
    ): Boolean {
        if (profile.developerMode) return true
        if (_state.value.session.has(capability)) return true

        bootstrapAndStart(force = true)
        setError(
            "$actionLabel is waiting for host-authorized full access to refresh."
        )
        return false
    }

    fun approveCandidate(id: String) {
        if (!requireCapability("candidate:review", "Candidate approval")) return
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
        if (!requireCapability("candidate:review", "Candidate denial")) return
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

    fun openLog(service: String) {
        if (
            !requireCapability(
                "logs:read",
                "Open current-week log"
            )
        ) {
            return
        }

        val cleanService = service.trim()
        if (cleanService.isBlank()) {
            setError(
                "A log service is required"
            )
            return
        }

        viewModelScope.launch {
            _state.update {
                it.copy(
                    logWorkspaceTitle =
                        cleanService
                            .replace('_', ' ')
                            .uppercase(),
                    logWorkspaceService =
                        cleanService,
                    logWorkspaceText =
                        "Loading authenticated current-week log…",
                    logWorkspaceLoading = true,
                    error = null
                )
            }
            try {
                val result =
                    backend.getLog(cleanService)
                if (
                    result.booleanOrNull(
                        "exists"
                    ) != true
                ) {
                    throw IllegalStateException(
                        result.stringOrNull(
                            "error"
                        ) ?:
                            "The selected current-week log is unavailable"
                    )
                }
                _state.update {
                    it.copy(
                        logWorkspaceTitle =
                            result.stringOrNull(
                                "display_name"
                            ) ?:
                                cleanService
                                    .replace('_', ' ')
                                    .uppercase(),
                        logWorkspaceText =
                            result.stringOrNull(
                                "text"
                            ).orEmpty().ifBlank {
                                "(No log activity was captured this week.)"
                            },
                        logWorkspaceLoading = false
                    )
                }
            } catch (
                error:
                    kotlinx.coroutines.CancellationException
            ) {
                throw error
            } catch (
                error: FlokiUnauthorizedException
            ) {
                recoverUnauthorized()
                _state.update {
                    it.copy(
                        logWorkspaceLoading = false,
                        logWorkspaceText =
                            "Host authorization is refreshing. Reopen the log in a moment."
                    )
                }
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        logWorkspaceLoading = false,
                        logWorkspaceText =
                            error.message ?:
                                "Could not load current-week log"
                    )
                }
            }
        }
    }

    fun refreshOpenLog() {
        val service =
            _state.value.logWorkspaceService
        if (service.isNotBlank()) {
            openLog(service)
        }
    }

    fun closeLogWorkspace() {
        _state.update {
            it.copy(
                logWorkspaceTitle = null,
                logWorkspaceService = "",
                logWorkspaceText = "",
                logWorkspaceLoading = false
            )
        }
    }

    fun pauseRsi() {
        if (!requireCapability("self_improvement:control", "Pausing self-improvement")) return
        authenticatedAction("pause", "/self-improvement/pause")
    }

    fun resumeRsi() {
        if (!requireCapability("self_improvement:control", "Resuming self-improvement")) return
        authenticatedAction("resume", "/self-improvement/resume")
    }

    fun runRsi(objective: String) {
        if (!requireCapability("self_improvement:control", "Run Now")) return
        val body = JSONObject()
            .put(
                "kind",
                "code"
            )
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

fun trainRsi(objective: String) {
        if (!requireCapability("self_improvement:control", "Run Now")) return
        val body = JSONObject()
            .put(
                "kind",
                "training"
            )
        val cleanObjective = objective.trim()
        if (cleanObjective.isNotBlank()) body.put("objective", cleanObjective)

        runAction("train-now") {
            val response = backend.post("/self-improvement/run-now", body)
            if (response.booleanOrNull("ok") == false) {
                throw IllegalStateException(
                    response.stringOrNull("error") ?: "RSI training failed"
                )
            }
            response.stringOrNull("message") ?: "RSI training started"
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
        reconnectAutomaticAccess()
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
                if (
                    error is FlokiUnauthorizedException
                ) {
                    recoverUnauthorized()
                }
                _state.update {
                    it.copy(
                        busyAction = null,
                        error = error.message
                            ?: "$name failed"
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
        tokenRefreshJob?.cancel()
        terminalPollingJob?.cancel()
        visionPollingJob?.cancel()
        socket?.close(1000, "profile changed")
        backend.close()

        backend = FlokiBackend(
            profile,
            accessCredential
        )
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

        val transportAuthenticated =
            profile.developerMode ||
                accessCredential.isNotBlank()

        if (!transportAuthenticated) {
            return
        }

        startMobileHeartbeat(generation)
        if (normalMobileTransportEnabled) {
            connectSocket(generation)
        }

        if (!profile.developerMode) {
            tokenRefreshJob = viewModelScope.launch {
                val refreshDelay = (
                    accessExpiresAtMs -
                        System.currentTimeMillis() -
                        60_000L
                ).coerceAtLeast(30_000L)

                delay(refreshDelay)

                if (
                    isActive &&
                    generation == transportGeneration
                ) {
                    bootstrapAndStart(force = true)
                }
            }
        }

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
                var metadataTick = 0
                while (isActive && generation == transportGeneration) {
                    val cycleStartedAt = System.currentTimeMillis()
                    pollVisionFrameOnce()
                    if (metadataTick % 2 == 0) {
                        pollVisionMetadataOnce()
                    }
                    metadataTick += 1
                    val elapsed = System.currentTimeMillis() - cycleStartedAt
                    delay((VISION_POLL_TARGET_MS - elapsed).coerceAtLeast(25L))
                }
            }
        }
    }

    private fun startMobileHeartbeat(generation: Int) {
        heartbeatJob = viewModelScope.launch {
            while (
                isActive &&
                generation == transportGeneration
            ) {
                try {
                    sendMobileHeartbeat()
                } catch (
                    error: FlokiUnauthorizedException
                ) {
                    recoverUnauthorized()
                    break
                } catch (_: Exception) {
                }
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
                        val authorizationFailure =
                            message.contains("401") ||
                                message.contains(
                                    "unauthorized",
                                    ignoreCase = true
                                ) ||
                                message.contains(
                                    "invalid token",
                                    ignoreCase = true
                                )

                        _state.update {
                            it.copy(
                                websocketConnected = false,
                                message =
                                    if (
                                        authorizationFailure
                                    ) {
                                        "Renewing automatic access…"
                                    } else {
                                        "Reconnecting secure transport…"
                                    },
                                error = null
                            )
                        }

                        if (authorizationFailure) {
                            recoverUnauthorized()
                        } else {
                            scheduleSocketReconnect(
                                generation
                            )
                        }
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
        bootstrapJob?.cancel()
        tokenRefreshJob?.cancel()
        terminalPollingJob?.cancel()
        visionPollingJob?.cancel()
        voiceJob?.cancel()
        socket?.close(1000, "app closing")
        backend.close()
    }

    private fun parseSession(json: JSONObject): SessionSnapshot {
        val user = json.optJSONObject("user") ?: JSONObject()
        val capabilitiesArray = json.optJSONArray("capabilities") ?: JSONArray()
        val capabilities = buildSet {
            for (index in 0 until capabilitiesArray.length()) {
                capabilitiesArray.optString(index).takeIf { it.isNotBlank() }?.let(::add)
            }
        }
        return SessionSnapshot(
            signedIn = json.booleanOrNull("ok") == true,
            account = user.stringOrNull("sub"),
            role = user.stringOrNull("role"),
            status = user.stringOrNull("status"),
            expiresAt = user.longOrNull("expires_at"),
            capabilities = capabilities,
            lastError = null
        )
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
                        controlGeneration = item.longOrNull("controlGeneration"),
                        logAvailable = item.booleanOrNull("logAvailable") == true,
                        logKey = item.stringOrNull("logKey")
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
            currentObjective = status.stringOrNull("current_objective")
                ?: status.stringOrNull("active_goal"),
            activeRole = status.stringOrNull("active_role"),
            activeTool = status.stringOrNull("active_tool"),
            resourceMode = status.stringOrNull("resource_mode"),
            gpuOwner = status.stringOrNull("gpu_owner"),
            gpuWorkloadOwner = status.stringOrNull("gpu_workload_owner"),
            telemetryStale = status.booleanOrNull("telemetry_stale") == true,
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
                val FULL_HOST_CAPABILITIES =
            setOf(
            "auth:read",
            "candidate:review",
            "chat:use",
            "dreams:read",
            "logs:read",
            "memory:read",
            "neural:read",
            "runtime:control",
            "schedule:write",
            "self_improvement:control",
            "self_improvement:read",
            "settings:write",
            "system:control",
            "system:read",
            "uploads:write",
            "vision:read",
            "voice:use",
            "ws:connect",
            )
const val VISION_POLL_TARGET_MS = 300L
        const val VISION_FRAME_GRACE_MS = 2_500L
        const val VISION_AUTHORITATIVE_OFFLINE_CONFIRMATIONS = 3
        const val AUTO_ACCESS_RETRY_BASE_MS = 2_000L
        const val AUTO_ACCESS_RETRY_MAX_MS = 30_000L
        val MODULE_ACTIONS = setOf("start", "stop", "reset")
    }
}
