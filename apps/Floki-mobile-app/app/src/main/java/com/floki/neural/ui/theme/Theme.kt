package com.floki.neural.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val FlokiBackground = Color(0xFF070B14)
val FlokiSurface = Color(0xFF0B111C)
val FlokiSurfaceAlt = Color(0xFF111A2A)
val FlokiBorder = Color(0xFF243247)
val FlokiText = Color(0xFFE3FAFF)
val FlokiTextDim = Color(0xFF8395A9)
val NeonCyan = Color(0xFF00E5FF)
val NeonBlue = Color(0xFF338CFF)
val NeonGreen = Color(0xFF34D17F)
val NeonAmber = Color(0xFFF5A623)
val NeonRed = Color(0xFFE23B3B)
val NeonViolet = Color(0xFFB388FF)

private val Colors = darkColorScheme(
    primary = NeonCyan,
    onPrimary = FlokiBackground,
    secondary = NeonBlue,
    background = FlokiBackground,
    onBackground = FlokiText,
    surface = FlokiSurface,
    onSurface = FlokiText,
    outline = FlokiBorder,
    error = NeonRed
)

@Composable
fun FlokiTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = Colors,
        typography = Typography(),
        content = content
    )
}
