package com.floki.neural.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Hearing
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Science
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Timeline
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.core.content.ContextCompat
import com.floki.neural.ui.theme.FlokiBackground
import com.floki.neural.ui.theme.FlokiBorder
import com.floki.neural.ui.theme.FlokiSurface
import com.floki.neural.ui.theme.FlokiSurfaceAlt
import com.floki.neural.ui.theme.FlokiText
import com.floki.neural.ui.theme.FlokiTextDim
import com.floki.neural.ui.theme.NeonAmber
import com.floki.neural.ui.theme.NeonCyan
import com.floki.neural.ui.theme.NeonGreen
import com.floki.neural.ui.theme.NeonRed
import com.floki.neural.ui.theme.NeonViolet
import android.graphics.BitmapFactory
import android.graphics.Paint as AndroidPaint
import java.text.DateFormat
import java.util.Date

private val ACTIVE_RSI_STATUSES = setOf(
    "pending_review",
    "approved",
    "validating",
    "deploying",
    "promotion_failed",
    "validation_failed",
    "deployment_failed"
)

private enum class MobileTab(val label: String, val icon: ImageVector) {
    CHAT("Chat", Icons.AutoMirrored.Filled.Chat),
    VISION("Vision", Icons.Filled.Visibility),
    DREAMS("Dreams", Icons.Filled.Bedtime),
    NEURAL("Neural", Icons.Filled.Timeline),
    SYSTEM("System", Icons.Filled.Build),
    RSI("RSI", Icons.Filled.Science),
    RSI_TERMINAL("RSI Log", Icons.Filled.Timeline),
    SETTINGS("Settings", Icons.Filled.Settings)
}

@Composable
fun FlokiMobileApp(vm: FlokiViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    var tab by rememberSaveable { mutableStateOf(MobileTab.CHAT) }

    Scaffold(
        containerColor = FlokiBackground,
        topBar = { Header(state = state, onRefresh = vm::refresh) },
        bottomBar = {
            NavigationBar(containerColor = FlokiSurface) {
                MobileTab.entries.forEach { item ->
                    NavigationBarItem(
                        selected = tab == item,
                        onClick = { tab = item },
                        icon = {
                            Icon(
                                item.icon,
                                contentDescription = item.label,
                                modifier = Modifier.size(18.dp)
                            )
                        },
                        label = {
                            Text(item.label, fontSize = 7.sp, maxLines = 1)
                        },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = NeonCyan,
                            selectedTextColor = NeonCyan,
                            indicatorColor = NeonCyan.copy(alpha = 0.12f),
                            unselectedIconColor = FlokiTextDim,
                            unselectedTextColor = FlokiTextDim
                        )
                    )
                }
            }
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            MessageBanner(state = state, onClear = vm::clearMessage)
            LogWorkspaceDialog(state, vm)
            when (tab) {
                MobileTab.CHAT -> ChatScreen(state, vm)
                MobileTab.VISION -> VisionScreen(state, vm)
                MobileTab.DREAMS -> DreamsScreen(state, vm)
                MobileTab.NEURAL -> NeuralScreen(state)
                MobileTab.SYSTEM -> SystemScreen(state, vm)
                MobileTab.RSI -> RsiScreen(state, vm)
                MobileTab.RSI_TERMINAL -> RsiTerminalScreen(state, vm)
                MobileTab.SETTINGS -> SettingsScreen(state, vm)
            }
        }
    }
}

@Composable
private fun LogWorkspaceDialog(
    state: FlokiUiState,
    vm: FlokiViewModel
) {
    val title =
        state.logWorkspaceTitle ?: return

    AlertDialog(
        onDismissRequest =
            vm::closeLogWorkspace,
        confirmButton = {
            TextButton(
                onClick =
                    vm::closeLogWorkspace
            ) {
                Text("Close")
            }
        },
        dismissButton = {
            TextButton(
                onClick =
                    vm::refreshOpenLog,
                enabled =
                    !state.logWorkspaceLoading
            ) {
                Text("Refresh")
            }
        },
        title = {
            Text(
                title,
                color = NeonCyan,
                fontFamily =
                    FontFamily.Monospace,
                fontSize = 13.sp
            )
        },
        text = {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(460.dp)
                    .background(
                        Color.Black,
                        RoundedCornerShape(7.dp)
                    )
                    .padding(10.dp)
                    .verticalScroll(
                        rememberScrollState()
                    )
            ) {
                Text(
                    state.logWorkspaceText,
                    color =
                        if (
                            state.logWorkspaceLoading
                        ) {
                            NeonAmber
                        } else {
                            FlokiText
                        },
                    fontFamily =
                        FontFamily.Monospace,
                    fontSize = 9.sp
                )
            }
        },
        containerColor = FlokiSurface
    )
}

@Composable
private fun Header(state: FlokiUiState, onRefresh: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(FlokiSurface)
            .padding(start = 16.dp, end = 8.dp, top = 14.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "FLOKI MOBILE",
                color = NeonCyan,
                fontWeight = FontWeight.Bold,
                letterSpacing = 1.5.sp
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(if (state.connected) NeonGreen else NeonRed)
                Spacer(Modifier.width(7.dp))
                Text(
                    text = if (state.connected) {
                        "${state.runtime.state} · ${state.runtime.model}"
                    } else {
                        "${state.connectionState} · ${state.profile.host}:${state.profile.port}"
                    },
                    color = FlokiTextDim,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = if (state.websocketConnected) "WSS" else "POLL",
                    color = when {
                        state.websocketConnected -> NeonGreen
                        state.connected -> NeonAmber
                        else -> NeonRed
                    },
                    fontFamily = FontFamily.Monospace,
                    fontSize = 9.sp
                )
            }
        }
        IconButton(onClick = onRefresh, enabled = !state.refreshing) {
            Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = NeonCyan)
        }
    }
}

@Composable
private fun MessageBanner(state: FlokiUiState, onClear: () -> Unit) {
    val text = state.error ?: state.message ?: return
    val isError = state.error != null
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (isError) NeonRed.copy(alpha = 0.16f)
                else NeonGreen.copy(alpha = 0.12f)
            )
            .clickable(onClick = onClear)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = text,
            color = if (isError) NeonRed else NeonGreen,
            fontSize = 11.sp,
            modifier = Modifier.weight(1f)
        )
        Text(
            "DISMISS",
            color = FlokiTextDim,
            fontFamily = FontFamily.Monospace,
            fontSize = 9.sp
        )
    }
}

@Composable
private fun ChatScreen(state: FlokiUiState, vm: FlokiViewModel) {
    var message by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    val microphonePermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        vm.updateAudioPermission(granted)
        if (granted) vm.startVoiceRecording()
    }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (state.chat.isEmpty()) {
                item {
                    EmptyPanel(
                        "No transcript entries yet. Start chat.local and connect to Floki."
                    )
                }
            }
            items(state.chat, key = { it.id }) { chat ->
                val isFloki = chat.role == "assistant" || chat.role == "floki"
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = if (isFloki) FlokiSurface else FlokiSurfaceAlt
                    )
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(
                            if (isFloki) "FLOKI" else "YOU",
                            color = if (isFloki) NeonCyan else NeonViolet,
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.Bold,
                            fontSize = 9.sp
                        )
                        Spacer(Modifier.height(5.dp))
                        Text(chat.content, color = FlokiText, fontSize = 14.sp)
                        Spacer(Modifier.height(5.dp))
                        Text(
                            formatTime(chat.timestamp),
                            color = FlokiTextDim,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 9.sp
                        )
                    }
                }
            }
        }

        if (state.recording) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(NeonViolet.copy(alpha = 0.12f))
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center
            ) {
                StatusDot(NeonRed)
                Spacer(Modifier.width(8.dp))
                Text(
                    "RECORDING VOICE…",
                    color = NeonViolet,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    fontSize = 11.sp
                )
                Spacer(Modifier.width(12.dp))
                TextButton(onClick = vm::stopVoiceRecording) {
                    Text("CANCEL", color = NeonRed, fontSize = 11.sp)
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(FlokiSurface)
                .padding(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = message,
                onValueChange = { message = it },
                placeholder = { Text("Talk to Floki") },
                modifier = Modifier.weight(1f),
                colors = fieldColors(),
                maxLines = 4
            )
            Spacer(Modifier.width(8.dp))
            IconButton(
                onClick = {
                    val granted = ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.RECORD_AUDIO
                    ) == PackageManager.PERMISSION_GRANTED
                    vm.updateAudioPermission(granted)
                    if (granted) {
                        vm.startVoiceRecording()
                    } else {
                        microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
                    }
                },
                enabled = state.busyAction == null && !state.recording
            ) {
                Icon(
                    Icons.Filled.RecordVoiceOver,
                    contentDescription = "Record voice message",
                    tint = if (state.recording) NeonRed else NeonViolet
                )
            }
            Spacer(Modifier.width(4.dp))
            IconButton(
                onClick = {
                    vm.sendChat(message)
                    message = ""
                },
                enabled = message.isNotBlank() && state.busyAction == null && !state.recording
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.Send,
                    contentDescription = "Send",
                    tint = NeonCyan
                )
            }
        }
    }
}

@Composable
private fun DreamsScreen(state: FlokiUiState, vm: FlokiViewModel) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Panel("SLEEP STATE") {
                KeyValue("State", state.sleep.state)
                KeyValue("Sleep remaining", formatDuration(state.sleep.remainingMs))
                KeyValue("Next REM", formatDuration(state.sleep.nextRemCountdownMs))
                KeyValue("REM progress", remProgress(state.sleep))
                KeyValue("Current REM", state.sleep.currentRemCycle?.toString() ?: "—")
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionButton(
                        "30-minute nap",
                        Icons.Filled.Bedtime,
                        NeonViolet,
                        state.busyAction == null
                    ) { vm.requestNap() }
                    ActionButton(
                        "Wake",
                        Icons.Filled.PlayArrow,
                        NeonGreen,
                        state.busyAction == null
                    ) { vm.wake() }
                }
            }
        }
        if (state.dreams.isEmpty()) {
            item { EmptyPanel("No indexed dreams were returned by /interface/dreams.") }
        }
        items(state.dreams, key = { it.id }) { dream ->
            Panel(dream.title.uppercase()) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        "REM ${dream.remCycle ?: "—"}",
                        color = NeonViolet,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp
                    )
                    Text(
                        formatTime(dream.timestamp),
                        color = FlokiTextDim,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 9.sp
                    )
                }
                if (dream.story.isNotBlank()) {
                    Spacer(Modifier.height(7.dp))
                    Text(
                        dream.story,
                        color = FlokiText,
                        fontSize = 13.sp,
                        maxLines = 16,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }
    }
}

@Composable
private fun NeuralScreen(state: FlokiUiState) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        if (state.neural.isEmpty()) {
            item {
                EmptyPanel(
                    "No first-person neural stream entries were returned by /interface/neural."
                )
            }
        }
        items(state.neural, key = { it.id }) { event ->
            Panel(event.module.uppercase()) {
                Text(event.summary, color = FlokiText, fontSize = 13.sp)
                Spacer(Modifier.height(5.dp))
                Text(
                    formatTime(event.timestamp),
                    color = FlokiTextDim,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 9.sp
                )
            }
        }
    }
}

@Composable
private fun SystemScreen(state: FlokiUiState, vm: FlokiViewModel) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Panel("RUNTIME") {
                KeyValue("State", state.runtime.state)
                KeyValue("Mode", state.runtime.mode)
                KeyValue("Model", state.runtime.model)
                KeyValue("Fully ready", yesNo(state.runtime.ready))
                Spacer(Modifier.height(8.dp))
                SensorRow(Icons.Filled.Visibility, "Vision", state.runtime.vision)
                SensorRow(Icons.Filled.Hearing, "Hearing", state.runtime.hearing)
                SensorRow(Icons.Filled.RecordVoiceOver, "Speech", state.runtime.speech)
                SensorRow(Icons.Filled.Science, "Memory", state.runtime.memory)
            }
        }
        item {
            Panel("CONTROLS") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionButton(
                        "Vision",
                        Icons.Filled.Visibility,
                        NeonCyan,
                        state.busyAction == null
                    ) { vm.control("restartVision") }
                    ActionButton(
                        "Hearing",
                        Icons.Filled.Hearing,
                        NeonGreen,
                        state.busyAction == null
                    ) { vm.control("restartHearing") }
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionButton(
                        "Speech",
                        Icons.Filled.RecordVoiceOver,
                        NeonViolet,
                        state.busyAction == null
                    ) { vm.control("restartSpeech") }
                    ActionButton(
                        "Interrupt",
                        Icons.Filled.Stop,
                        NeonRed,
                        state.busyAction == null
                    ) { vm.control("interrupt") }
                }
            }
        }
        items(state.services, key = { it.key }) { service ->
            val color = when (service.status.lowercase()) {
                "running" -> NeonGreen
                "degraded" -> NeonAmber
                else -> NeonRed
            }
            Panel(service.name.uppercase()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(color)
                    Spacer(Modifier.width(7.dp))
                    Text(
                        service.status,
                        color = color,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp
                    )
                }
                if (service.detail.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    Text(service.detail, color = FlokiTextDim, fontSize = 11.sp)
                }
                if (service.clientApp) {
                    Spacer(Modifier.height(6.dp))
                    KeyValue("Enabled", yesNo(service.enabled))
                    KeyValue(
                        "Clients",
                        "${service.healthyClientCount ?: 0}/${service.connectedClientCount ?: 0}"
                    )
                    KeyValue("Transport", service.transportType ?: "none")
                    KeyValue("Generation", service.controlGeneration?.toString() ?: "—")
                }
                service.lastError?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        it,
                        color = NeonRed,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp
                    )
                }
                Spacer(Modifier.height(8.dp))
                ActionButton(
                    "Current-week log",
                    Icons.Filled.Timeline,
                    NeonCyan,
                    state.busyAction == null && service.logAvailable
                ) {
                    vm.openLog(service.logKey ?: service.key)
                }
                if (service.startAvailable || service.stopAvailable || service.resetAvailable) {
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (service.startAvailable) {
                            ActionButton(
                                "Start",
                                Icons.Filled.PlayArrow,
                                NeonGreen,
                                state.busyAction == null
                            ) { vm.controlModule(service.key, "start") }
                        }
                        if (service.stopAvailable) {
                            ActionButton(
                                "Stop",
                                Icons.Filled.Stop,
                                NeonRed,
                                state.busyAction == null
                            ) { vm.controlModule(service.key, "stop") }
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    if (service.resetAvailable) {
                        ActionButton(
                            "Restart",
                            Icons.Filled.Refresh,
                            NeonCyan,
                            state.busyAction == null
                        ) { vm.controlModule(service.key, "reset") }
                    }
                }
            }
        }
    }
}

@Composable
private fun RsiScreen(state: FlokiUiState, vm: FlokiViewModel) {
    var objective by rememberSaveable { mutableStateOf("") }
    var denialReason by rememberSaveable { mutableStateOf("") }
    var candidateView by rememberSaveable { mutableStateOf("pending") }

    val pending = remember(state.candidates) {
        state.candidates
            .filter { it.status in ACTIVE_RSI_STATUSES }
            .sortedBy { it.createdAt }
    }
    val history = remember(state.candidates) {
        state.candidates
            .filter { it.status !in ACTIVE_RSI_STATUSES }
            .sortedByDescending { it.createdAt }
    }
    val shown = if (candidateView == "history") history else pending
    val canControlRsi = state.profile.developerMode ||
        state.session.has("self_improvement:control")
    val canReviewCandidates = state.profile.developerMode ||
        state.session.has("candidate:review")
    val runBlocked = state.busyAction != null ||
        state.rsi.paused ||
        state.rsi.currentRunId != null ||
        state.rsi.state in setOf(
            "queued",
            "starting",
            "researching",
            "experimenting",
            "verifying",
            "promoting"
        )

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Panel("RSI CONTROLLER") {
                KeyValue("State", state.rsi.state)
                KeyValue("Phase", state.rsi.phase)
                KeyValue("Paused", yesNo(state.rsi.paused))
                KeyValue("Worker", if (state.rsi.workerRunning) "running" else "stopped")
                KeyValue("Model proxy", if (state.rsi.modelProxyReady) "ready" else "not ready")
                KeyValue("Current run", state.rsi.currentRunId ?: "—")
                KeyValue("Sandbox", state.rsi.currentContainer ?: "—")
                KeyValue("Goal", state.rsi.currentObjective ?: "—")
                KeyValue("Role", state.rsi.activeRole ?: "—")
                KeyValue("Tool", state.rsi.activeTool ?: "—")
                KeyValue("Resource", state.rsi.resourceMode ?: "idle")
                KeyValue(
                    "GPU owner",
                    state.rsi.gpuOwner ?: state.rsi.gpuWorkloadOwner ?: "none"
                )
                if (state.rsi.telemetryStale) {
                    KeyValue("Telemetry", "stale")
                }
                state.rsi.lastError?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(it, color = NeonRed, fontSize = 11.sp)
                }
                if (!canControlRsi) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "HOST AUTHORIZATION IS RESTORING FULL CONTROL",
                        color = NeonAmber,
                        fontSize = 10.sp
                    )
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ActionButton(
                        "Pause",
                        Icons.Filled.Pause,
                        NeonAmber,
                        canControlRsi && state.busyAction == null && !state.rsi.paused
                    ) { vm.pauseRsi() }
                    ActionButton(
                        "Resume",
                        Icons.Filled.PlayArrow,
                        NeonGreen,
                        canControlRsi && state.busyAction == null && state.rsi.paused
                    ) { vm.resumeRsi() }
                }
                Spacer(Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    ActionButton(
                        "Worker log",
                        Icons.Filled.Timeline,
                        NeonCyan,
                        state.busyAction == null
                    ) {
                        vm.openLog("rsi_worker")
                    }
                    ActionButton(
                        "Active log",
                        Icons.Filled.Timeline,
                        NeonViolet,
                        state.busyAction == null
                    ) {
                        vm.openLog("rsi_sandbox")
                    }
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = objective,
                    onValueChange = { objective = it },
                    label = { Text("Experiment objective — optional") },
                    placeholder = {
                        Text("Leave empty for Floki to choose his own experiment")
                    },
                    modifier = Modifier.fillMaxWidth(),
                    colors = fieldColors(),
                    minLines = 2,
                    maxLines = 5
                )
                Spacer(Modifier.height(6.dp))
                ActionButton(
                    "Run now",
                    Icons.Filled.Science,
                    NeonViolet,
                    canControlRsi && !runBlocked
                ) {
                    vm.runRsi(objective)
                    objective = ""
                }
                Spacer(Modifier.height(8.dp))
                ActionButton(
                    "Train now",
                    Icons.Filled.Build,
                    NeonCyan,
                    !runBlocked
                ) {
                    vm.trainRsi(
                        objective
                    )
                    objective = ""
                }
            }
        }

        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                TextButton(onClick = { candidateView = "pending" }) {
                    Text(
                        "PENDING ${pending.size}",
                        color = if (candidateView == "pending") NeonCyan else FlokiTextDim,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold
                    )
                }
                TextButton(onClick = { candidateView = "history" }) {
                    Text(
                        "HISTORY ${history.size}",
                        color = if (candidateView == "history") NeonCyan else FlokiTextDim,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }

        if (shown.isEmpty()) {
            item {
                EmptyPanel(
                    if (candidateView == "history") "No past candidates yet."
                    else "No candidate is awaiting review."
                )
            }
        }

        items(shown, key = { it.id }) { candidate ->
            Panel(candidate.id) {
                KeyValue("Status", candidate.status.replace('_', ' '))
                KeyValue("Risk", candidate.riskLevel)
                Spacer(Modifier.height(5.dp))
                Text(
                    candidate.objective,
                    color = FlokiText,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 13.sp
                )
                if (candidate.summary.isNotBlank()) {
                    Spacer(Modifier.height(5.dp))
                    Text(
                        candidate.summary,
                        color = FlokiTextDim,
                        fontSize = 11.sp,
                        maxLines = 14,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                if (candidate.status == "pending_review") {
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = denialReason,
                        onValueChange = { denialReason = it },
                        label = { Text("Denial reason") },
                        modifier = Modifier.fillMaxWidth(),
                        colors = fieldColors(),
                        minLines = 2
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ActionButton(
                            "Deny",
                            Icons.Filled.Close,
                            NeonRed,
                            canReviewCandidates && state.busyAction == null && denialReason.isNotBlank()
                        ) {
                            vm.denyCandidate(candidate.id, denialReason)
                            denialReason = ""
                        }
                        ActionButton(
                            "Approve",
                            Icons.Filled.Check,
                            NeonGreen,
                            canReviewCandidates && state.busyAction == null
                        ) {
                            vm.approveCandidate(candidate.id)
                        }
                    }
                    if (!canReviewCandidates) {
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "Review disabled: this account lacks candidate:review",
                            color = NeonAmber,
                            fontSize = 10.sp
                        )
                    }
                } else {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Read-only ${if (candidateView == "history") "history" else "promotion state"}",
                        color = FlokiTextDim,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 9.sp
                    )
                }
            }
        }
    }
}

@Composable
private fun RsiTerminalScreen(state: FlokiUiState, vm: FlokiViewModel) {
    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(FlokiSurface)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    "RSI READ-ONLY TERMINAL",
                    color = NeonCyan,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    fontSize = 11.sp
                )
                Text(
                    "gen #${state.rsiTerminalGeneration} · ${if (state.rsiTerminalActive) "ACTIVE" else "IDLE"}",
                    color = FlokiTextDim,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 9.sp
                )
            }
            IconButton(onClick = { vm.refreshRsiTerminal(reset = true) }) {
                Icon(Icons.Filled.Refresh, contentDescription = "Reload RSI terminal", tint = NeonCyan)
            }
        }

        state.rsiTerminalError?.let {
            Text(
                it,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(NeonRed.copy(alpha = 0.12f))
                    .padding(10.dp),
                color = NeonRed,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp
            )
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 0.38f))
                .padding(10.dp)
        ) {
            val scrollState = rememberScrollState()
            Text(
                text = state.rsiTerminalText.ifBlank { "Waiting for RSI terminal output…" },
                color = if (state.rsiTerminalText.isBlank()) FlokiTextDim else FlokiText,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(scrollState)
            )
        }
    }
}

@Composable
private fun VisionScreen(state: FlokiUiState, vm: FlokiViewModel) {
    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(FlokiSurface)
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    "VISION FEED",
                    color = NeonCyan,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    fontSize = 11.sp
                )
                Text(
                    text = "%.1f FPS · %d boxes · %s".format(
                        state.visionOverlay.frameRate,
                        state.visionOverlay.detections.size,
                        state.visionTransportState
                    ),
                    color = if (state.visionTransportState == "live") NeonGreen else NeonAmber,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 9.sp
                )
            }
            Text(
                "gen #${state.visionFrameGeneration}",
                color = FlokiTextDim,
                fontFamily = FontFamily.Monospace,
                fontSize = 9.sp
            )
            Spacer(Modifier.width(8.dp))
            IconButton(onClick = { vm.refreshVisionFrame() }) {
                Icon(
                    Icons.Filled.Refresh,
                    contentDescription = "Refresh Vision frame",
                    tint = NeonCyan
                )
            }
        }

        val bytes = state.visionFrameBytes
        val bitmap = remember(bytes, state.visionFrameGeneration) {
            if (bytes == null) null else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
            contentAlignment = Alignment.Center
        ) {
            if (bitmap != null) {
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = "Vision feed",
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black),
                    contentScale = ContentScale.Fit
                )

                VisionDetectionOverlay(
                    sourceWidth = bitmap.width,
                    sourceHeight = bitmap.height,
                    detections = state.visionOverlay.detections,
                    detectionFresh = state.visionOverlay.detectionFresh
                )

                if (state.visionTransportState == "reconnecting") {
                    Text(
                        "RECONNECTING · LAST GOOD FRAME",
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .padding(top = 10.dp)
                            .background(
                                Color.Black.copy(alpha = 0.72f),
                                RoundedCornerShape(6.dp)
                            )
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        color = NeonAmber,
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        fontSize = 9.sp
                    )
                }
            } else {
                Text(
                    text = if (state.visionTransportFailures > 0) {
                        "Reconnecting to Vision…"
                    } else {
                        "Waiting for Vision feed…"
                    },
                    color = FlokiTextDim,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp
                )
            }
        }
    }
}

@Composable
private fun VisionDetectionOverlay(
    sourceWidth: Int,
    sourceHeight: Int,
    detections: List<VisionDetection>,
    detectionFresh: Boolean
) {
    if (!detectionFresh || sourceWidth <= 0 || sourceHeight <= 0 || detections.isEmpty()) return

    Canvas(modifier = Modifier.fillMaxSize()) {
        val sourceWidthPx = sourceWidth.toFloat()
        val sourceHeightPx = sourceHeight.toFloat()
        val scale = minOf(size.width / sourceWidthPx, size.height / sourceHeightPx)
        val renderedWidth = sourceWidthPx * scale
        val renderedHeight = sourceHeightPx * scale
        val imageLeft = (size.width - renderedWidth) / 2f
        val imageTop = (size.height - renderedHeight) / 2f
        val strokeWidth = 2.dp.toPx()
        val labelTextSize = 11.sp.toPx()
        val labelPadding = 3.dp.toPx()
        val labelHeight = labelTextSize + labelPadding * 2f
        val textPaint = AndroidPaint().apply {
            isAntiAlias = true
            textSize = labelTextSize
            typeface = android.graphics.Typeface.MONOSPACE
        }

        detections.forEach { detection ->
            val color = visionDetectionColor(detection.kind)
            val left = imageLeft + detection.x * renderedWidth
            val top = imageTop + detection.y * renderedHeight
            val width = detection.width * renderedWidth
            val height = detection.height * renderedHeight
            if (width <= 1f || height <= 1f) return@forEach

            drawRect(
                color = color,
                topLeft = Offset(left, top),
                size = Size(width, height),
                style = Stroke(width = strokeWidth)
            )

            val confidenceText = detection.confidence?.let { " ${(it * 100f).toInt()}%" }.orEmpty()
            val label = detection.label + confidenceText
            textPaint.color = color.toArgb()
            val measuredWidth = textPaint.measureText(label)
            val backgroundWidth = (measuredWidth + labelPadding * 2f).coerceAtMost(width)
            val labelTop = (top - labelHeight).coerceAtLeast(imageTop)

            drawRect(
                color = Color.Black.copy(alpha = 0.76f),
                topLeft = Offset(left, labelTop),
                size = Size(backgroundWidth, labelHeight)
            )
            drawContext.canvas.nativeCanvas.drawText(
                label,
                left + labelPadding,
                labelTop + labelPadding + labelTextSize * 0.82f,
                textPaint
            )
        }
    }
}

private fun visionDetectionColor(kind: String): Color = when (kind.lowercase()) {
    "person" -> NeonCyan
    "face" -> NeonViolet
    else -> NeonGreen
}

@Composable
private fun SettingsScreen(state: FlokiUiState, vm: FlokiViewModel) {
    var host by remember(state.profile.host) { mutableStateOf(state.profile.host) }
    var port by remember(state.profile.port) { mutableStateOf(state.profile.port.toString()) }
    var poll by remember(state.profile.pollIntervalMs) {
        mutableStateOf(state.profile.pollIntervalMs.toString())
    }
    var useTls by remember(state.profile.useTls) { mutableStateOf(state.profile.useTls) }
    var developerMode by remember(state.profile.developerMode) {
        mutableStateOf(state.profile.developerMode)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Panel("CONNECTION") {
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text("Host or Tailscale DNS name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                colors = fieldColors()
            )
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = port,
                onValueChange = { port = it.filter(Char::isDigit) },
                label = { Text("Port") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                colors = fieldColors()
            )
            Spacer(Modifier.height(6.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Secure remote connection", color = FlokiText, fontSize = 12.sp)
                    Text(
                        "HTTPS + WSS for the public Floki gateway",
                        color = FlokiTextDim,
                        fontSize = 10.sp
                    )
                }
                Switch(
                    checked = useTls,
                    onCheckedChange = {
                        useTls = it
                        if (it && port == "7700") port = "443"
                    }
                )
            }
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = poll,
                onValueChange = { poll = it.filter(Char::isDigit) },
                label = { Text("Poll interval (ms)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
                colors = fieldColors()
            )
            Spacer(Modifier.height(10.dp))
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Developer local profile", color = FlokiText, fontSize = 12.sp)
                    Text(
                        "Allows loopback HTTP only for explicit USB debugging",
                        color = FlokiTextDim,
                        fontSize = 10.sp
                    )
                }
                Switch(
                    checked = developerMode,
                    onCheckedChange = { developerMode = it }
                )
            }
            Spacer(Modifier.height(10.dp))
            Button(
                onClick = {
                    vm.saveProfile(
                        host,
                        port,
                        poll,
                        useTls,
                        developerMode
                    )
                },
                colors = ButtonDefaults.buttonColors(
                    containerColor = NeonCyan,
                    contentColor = FlokiBackground
                )
            ) {
                Text(
                    "SAVE AND CONNECT",
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold
                )
            }
        }

        Panel("ACCOUNT") {
            KeyValue("Signed in as", state.session.account ?: "not signed in")
            KeyValue("Role", state.session.role ?: "—")
            KeyValue("Connection", state.connectionState)
            KeyValue(
                "Session",
                when {
                    state.session.signedIn -> "valid (${state.session.status ?: "active"})"
                    state.profile.sessionCredential.isBlank() -> "no credential"
                    else -> state.session.lastError ?: "not verified"
                }
            )
            if (state.session.capabilities.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Text("Capabilities", color = FlokiText, fontSize = 12.sp)
                Text(
                    state.session.capabilities.sorted().joinToString("\n"),
                    color = FlokiTextDim,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp
                )
            }
            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = vm::reconnectAutomaticAccess
            ) {
                Text(
                    "RECONNECT AUTOMATIC ACCESS",
                    fontFamily = FontFamily.Monospace
                )
            }
        }

        Panel("HOST-AUTHORIZED APK") {
            Text(
                "No login or token entry is required. " +
                    "Any device where you install this host-built APK " +
                    "receives full Floki access automatically.",
                color = FlokiTextDim,
                fontSize = 11.sp
            )
            Spacer(Modifier.height(7.dp))
            KeyValue(
                "Authorization",
                if (state.connected) {
                    "automatic access active"
                } else {
                    "automatic access connecting"
                }
            )
        }

        Panel("CONNECTION PROFILES") {
            Text(
                "USB development: enable developer local profile first",
                color = FlokiTextDim,
                fontSize = 11.sp
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Production: api.galactic-family-hub.com · port 443 · secure on",
                color = FlokiTextDim,
                fontSize = 11.sp
            )
        }

        Panel("ACTIVE ENDPOINT") {
            Text(
                state.profile.baseUrl,
                color = NeonCyan,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp
            )
            KeyValue("WebSocket", state.profile.webSocketUrl)
            KeyValue("Connection", if (state.connected) "online" else "offline")
            KeyValue("Transport", if (state.profile.useTls) "HTTPS/WSS" else "HTTP/WS")
        }
    }
}

@Composable
private fun Panel(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = FlokiSurface),
        border = androidx.compose.foundation.BorderStroke(1.dp, FlokiBorder)
    ) {
        Column(Modifier.fillMaxWidth().padding(13.dp)) {
            Text(
                title,
                color = NeonCyan,
                fontFamily = FontFamily.Monospace,
                fontSize = 10.sp,
                letterSpacing = 1.5.sp,
                fontWeight = FontWeight.Bold
            )
            Spacer(Modifier.height(8.dp))
            HorizontalDivider(color = FlokiBorder)
            Spacer(Modifier.height(9.dp))
            content()
        }
    }
}

@Composable
private fun EmptyPanel(message: String) {
    Panel("NO DATA") {
        Text(message, color = FlokiTextDim, fontSize = 12.sp)
    }
}

@Composable
private fun KeyValue(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            label,
            color = FlokiTextDim,
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp
        )
        Text(
            value,
            color = FlokiText,
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun SensorRow(icon: ImageVector, label: String, active: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (active) NeonGreen else NeonRed,
            modifier = Modifier.size(16.dp)
        )
        Spacer(Modifier.width(8.dp))
        Text(label, color = FlokiText, fontSize = 12.sp, modifier = Modifier.weight(1f))
        Text(
            if (active) "LIVE" else "OFFLINE",
            color = if (active) NeonGreen else NeonRed,
            fontFamily = FontFamily.Monospace,
            fontSize = 9.sp
        )
    }
}

@Composable
private fun ActionButton(
    label: String,
    icon: ImageVector,
    color: Color,
    enabled: Boolean,
    onClick: () -> Unit
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        border = androidx.compose.foundation.BorderStroke(1.dp, color.copy(alpha = 0.55f)),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = color),
        contentPadding = PaddingValues(horizontal = 11.dp, vertical = 8.dp)
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(15.dp))
        Spacer(Modifier.width(6.dp))
        Text(label, fontFamily = FontFamily.Monospace, fontSize = 10.sp)
    }
}

@Composable
private fun StatusDot(color: Color) {
    Box(Modifier.size(7.dp).background(color, CircleShape))
}

@Composable
private fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = NeonCyan,
    unfocusedBorderColor = FlokiBorder,
    focusedTextColor = FlokiText,
    unfocusedTextColor = FlokiText,
    cursorColor = NeonCyan,
    focusedLabelColor = NeonCyan,
    unfocusedLabelColor = FlokiTextDim
)

private fun yesNo(value: Boolean): String = if (value) "yes" else "no"

private fun remProgress(snapshot: SleepSnapshot): String {
    val complete = snapshot.completedRemCycles ?: return "—"
    val total = snapshot.totalRemCycles ?: return complete.toString()
    return "$complete/$total"
}

private fun formatDuration(value: Long?): String {
    val milliseconds = value ?: return "—"
    val seconds = milliseconds.coerceAtLeast(0L) / 1_000L
    val hours = seconds / 3_600L
    val minutes = (seconds % 3_600L) / 60L
    val remainingSeconds = seconds % 60L
    return if (hours > 0) {
        "%02d:%02d:%02d".format(hours, minutes, remainingSeconds)
    } else {
        "%02d:%02d".format(minutes, remainingSeconds)
    }
}

private fun formatTime(timestamp: Long): String {
    if (timestamp <= 0L) return "—"
    return DateFormat.getDateTimeInstance(
        DateFormat.SHORT,
        DateFormat.SHORT
    ).format(Date(timestamp))
}
