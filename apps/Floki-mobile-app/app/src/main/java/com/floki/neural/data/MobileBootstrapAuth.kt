package com.floki.neural.data

import android.util.Base64
import com.floki.neural.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class MobileBootstrapSession(
    val accessToken: String,
    val expiresInSeconds: Long
)

class MobileBootstrapAuth {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    suspend fun requestSession(
        deviceId: String
    ): MobileBootstrapSession = withContext(Dispatchers.IO) {
        val sharedSecret =
            BuildConfig.FLOKI_MOBILE_BOOTSTRAP_SECRET.trim()

        require(sharedSecret.matches(SECRET_PATTERN)) {
            "This APK is missing its host authorization secret"
        }
        require(deviceId.matches(DEVICE_ID_PATTERN)) {
            "The mobile device identifier is invalid"
        }

        val timestamp = (
            System.currentTimeMillis() / 1_000L
        ).toString()
        val nonce = randomUrlSafe(24)
        val payload = "$deviceId\n$timestamp\n$nonce"
        val signature = hmacSha256Hex(
            sharedSecret,
            payload
        )

        val request = Request.Builder()
            .url(SESSION_URL)
            .header("X-Floki-Device-Id", deviceId)
            .header("X-Floki-Timestamp", timestamp)
            .header("X-Floki-Nonce", nonce)
            .header("X-Floki-Signature", signature)
            .header("Cache-Control", "no-store")
            .post(ByteArray(0).toRequestBody(null))
            .build()

        client.newCall(request).execute().use { response ->
            val text = response.body.string()
            val json = runCatching {
                JSONObject(text)
            }.getOrElse {
                throw FlokiHttpException(
                    "Invalid host authorization response: " +
                        (it.message ?: "invalid JSON")
                )
            }

            if (
                !response.isSuccessful ||
                json.optBoolean("ok") != true
            ) {
                val detail = json.optString("error").trim()
                throw FlokiUnauthorizedException(
                    detail.ifBlank {
                        "Host authorization failed with HTTP " +
                            response.code
                    }
                )
            }

            val token = json.optString(
                "access_token"
            ).trim()
            val expiresIn = json.optLong(
                "expires_in",
                300L
            ).coerceAtLeast(60L)

            if (token.isBlank()) {
                throw FlokiHttpException(
                    "Host authorization returned no gateway token"
                )
            }

            MobileBootstrapSession(
                accessToken = token,
                expiresInSeconds = expiresIn
            )
        }
    }

    private fun hmacSha256Hex(
        secret: String,
        payload: String
    ): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(
            SecretKeySpec(
                secret.toByteArray(Charsets.UTF_8),
                "HmacSHA256"
            )
        )
        return mac.doFinal(
            payload.toByteArray(Charsets.UTF_8)
        ).joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xff)
        }
    }

    private fun randomUrlSafe(size: Int): String {
        val bytes = ByteArray(size)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(
            bytes,
            Base64.URL_SAFE or
                Base64.NO_WRAP or
                Base64.NO_PADDING
        )
    }

    private companion object {
        const val SESSION_URL =
            "https://galactic-family-hub.com/" +
                "wp-json/floki-mobile/v1/session"
        val SECRET_PATTERN = Regex(
            "^[a-f0-9]{128}$"
        )
        val DEVICE_ID_PATTERN = Regex(
            "^[A-Za-z0-9_.:-]{8,160}$"
        )
    }
}
