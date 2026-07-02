package com.floki.neural

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import com.floki.neural.ui.FlokiMobileApp
import com.floki.neural.ui.theme.FlokiBackground
import com.floki.neural.ui.theme.FlokiTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            FlokiTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = FlokiBackground
                ) {
                    FlokiMobileApp()
                }
            }
        }
    }
}
