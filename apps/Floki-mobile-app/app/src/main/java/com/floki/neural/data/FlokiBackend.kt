package com.floki.neural.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

data class ServerProfile(
    val host: String = "127.0.0.1",
    val port: Int = 7700,
    val pollIntervalMs: Long = 3_000L,
    val rsiApprovalToken: String = "",
    val useTls: Boolean = false
) {
    val baseUrl: String
        get() = "${if (useTls) "https" else "http"}://$host:$port"

    val webSocketUrl: String
        get() = "${if (useTls) "wss" else "ws"}://$host:$port/ws"
}

private class AndroidKeystoreTokenCipher {
    private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply {
        load(null)
    }

    @Synchronized
    private fun secretKey(): SecretKey {
        val existing = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing

        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEYSTORE
        )
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    fun encrypt(value: String): String {
        if (value.isBlank()) return ""

        val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())

        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val ciphertext = Base64.encodeToString(
            cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8)),
            Base64.NO_WRAP
        )
        return "$FORMAT_VERSION:$iv:$ciphertext"
    }

    fun decrypt(encoded: String): String {
        if (encoded.isBlank()) return ""

        val parts = encoded.split(':', limit = 3)
        require(parts.size == 3 && parts[0] == FORMAT_VERSION) {
            "Stored RSI approval token has an unsupported format"
        }

        try {
            val iv = Base64.decode(parts[1], Base64.NO_WRAP)
            val ciphertext = Base64.decode(parts[2], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(AES_GCM_TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey(),
                GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv)
            )
            return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
        } catch (error: Exception) {
            throw IllegalStateException(
                "Stored RSI approval token could not be decrypted",
                error
            )
        }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "floki_mobile_profile_aes_gcm_v2"
        const val AES_GCM_TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_LENGTH_BITS = 128
        const val FORMAT_VERSION = "v1"
    }
}

class ProfileStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_FILE,
        Context.MODE_PRIVATE
    )
    private val tokenCipher = AndroidKeystoreTokenCipher()

    init {
        val currentSchema = preferences.getInt(KEY_SCHEMA_VERSION, 0)
        when (currentSchema) {
            PROFILE_SCHEMA_VERSION -> Unit
            2 -> preferences.edit(commit = true) {
                putInt(KEY_SCHEMA_VERSION, PROFILE_SCHEMA_VERSION)
                putString(KEY_HOST, DEFAULT_HOST)
                putInt(KEY_PORT, DEFAULT_PORT)
                putBoolean(KEY_USE_TLS, DEFAULT_USE_TLS)
            }
            else -> preferences.edit(commit = true) {
                clear()
                putInt(KEY_SCHEMA_VERSION, PROFILE_SCHEMA_VERSION)
                putString(KEY_HOST, DEFAULT_HOST)
                putInt(KEY_PORT, DEFAULT_PORT)
                putBoolean(KEY_USE_TLS, DEFAULT_USE_TLS)
            }
        }
        check(
            preferences.getInt(KEY_SCHEMA_VERSION, 0) == PROFILE_SCHEMA_VERSION
        ) {
            "Could not migrate the Floki mobile profile store"
        }
    }

    fun load(): ServerProfile = ServerProfile(
        host = preferences.getString(KEY_HOST, DEFAULT_HOST)
            ?.trim()
            .orEmpty()
            .ifBlank { DEFAULT_HOST },
        port = preferences.getInt(KEY_PORT, DEFAULT_PORT)
            .takeIf { it in 1..65535 }
            ?: DEFAULT_PORT,
        pollIntervalMs = preferences.getLong(
            KEY_POLL_INTERVAL_MS,
            DEFAULT_POLL_INTERVAL_MS
        ).coerceIn(1_000L, 60_000L),
        rsiApprovalToken = tokenCipher.decrypt(
            preferences.getString(KEY_RSI_TOKEN, "").orEmpty()
        ),
        useTls = preferences.getBoolean(KEY_USE_TLS, DEFAULT_USE_TLS)
    )

    fun save(profile: ServerProfile) {
        val encryptedToken = tokenCipher.encrypt(profile.rsiApprovalToken.trim())
        val normalizedHost = profile.host.trim()
        val normalizedPollInterval = profile.pollIntervalMs.coerceIn(
            1_000L,
            60_000L
        )

        preferences.edit(commit = true) {
            putInt(KEY_SCHEMA_VERSION, PROFILE_SCHEMA_VERSION)
            putString(KEY_HOST, normalizedHost)
            putInt(KEY_PORT, profile.port)
            putLong(KEY_POLL_INTERVAL_MS, normalizedPollInterval)
            putBoolean(KEY_USE_TLS, profile.useTls)

            if (encryptedToken.isBlank()) {
                remove(KEY_RSI_TOKEN)
            } else {
                putString(KEY_RSI_TOKEN, encryptedToken)
            }
        }

        check(
            preferences.getString(KEY_HOST, null) == normalizedHost &&
                preferences.getInt(KEY_PORT, 0) == profile.port &&
                preferences.getLong(KEY_POLL_INTERVAL_MS, 0L) == normalizedPollInterval &&
                preferences.getBoolean(KEY_USE_TLS, !profile.useTls) == profile.useTls &&
                preferences.getString(KEY_RSI_TOKEN, "").orEmpty() == encryptedToken
        ) {
            "Could not persist the Floki mobile profile"
        }
    }

    private companion object {
        const val PREFERENCES_FILE = "floki_mobile_profile_v2"
        const val PROFILE_SCHEMA_VERSION = 3
        const val KEY_SCHEMA_VERSION = "schema_version"
        const val KEY_HOST = "host"
        const val KEY_PORT = "port"
        const val KEY_POLL_INTERVAL_MS = "poll_interval_ms"
        const val KEY_RSI_TOKEN = "rsi_approval_token_encrypted"
        const val KEY_USE_TLS = "use_tls"
        const val DEFAULT_HOST = "127.0.0.1"
        const val DEFAULT_PORT = 7700
        const val DEFAULT_POLL_INTERVAL_MS = 3_000L
        const val DEFAULT_USE_TLS = false
    }
}

class FlokiHttpException(message: String) : IOException(message)

class FlokiBackend(profile: ServerProfile) {
    private val baseUrl = profile.baseUrl
    private val webSocketUrl = profile.webSocketUrl
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    suspend fun getObject(path: String): JSONObject = withContext(Dispatchers.IO) {
        parseObject(execute(Request.Builder().url(url(path)).get().build()))
    }

    suspend fun getArray(path: String): JSONArray = withContext(Dispatchers.IO) {
        parseArray(execute(Request.Builder().url(url(path)).get().build()))
    }

    suspend fun post(path: String, body: JSONObject = JSONObject()): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url(path))
            .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        parseObject(execute(request))
    }

    fun openEvents(
        onOpen: () -> Unit,
        onMessage: (String) -> Unit,
        onFailure: (String) -> Unit,
        onClosed: () -> Unit
    ): WebSocket {
        val request = Request.Builder().url(webSocketUrl).build()
        return client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = onMessage(text)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onFailure(t.message ?: "WebSocket connection failed")
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onClosed()
        })
    }

    fun close() {
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    private fun url(path: String): String = "$baseUrl/${path.trimStart('/')}"

    private fun execute(request: Request): String {
        client.newCall(request).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) {
                val detail = runCatching { JSONObject(text).optString("error") }.getOrNull()
                throw FlokiHttpException(
                    detail?.takeIf { it.isNotBlank() }
                        ?: "HTTP ${response.code} ${response.message}"
                )
            }
            return text
        }
    }

    private fun parseObject(text: String): JSONObject {
        if (text.isBlank()) return JSONObject()
        return try {
            JSONObject(text)
        } catch (error: Exception) {
            throw FlokiHttpException("Invalid JSON object from Floki: ${error.message}")
        }
    }

    private fun parseArray(text: String): JSONArray {
        if (text.isBlank()) return JSONArray()
        return try {
            JSONArray(text)
        } catch (error: Exception) {
            throw FlokiHttpException("Invalid JSON array from Floki: ${error.message}")
        }
    }
}

internal fun JSONObject.stringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return optString(key).takeIf { it.isNotBlank() }
}

internal fun JSONObject.longOrNull(key: String): Long? {
    if (!has(key) || isNull(key)) return null
    val value = opt(key)
    return when (value) {
        is Number -> value.toLong()
        is String -> value.toLongOrNull()
        else -> null
    }
}

internal fun JSONObject.booleanOrNull(key: String): Boolean? {
    if (!has(key) || isNull(key)) return null
    return when (val value = opt(key)) {
        is Boolean -> value
        is String -> value.equals("true", ignoreCase = true)
        is Number -> value.toInt() != 0
        else -> null
    }
}

internal fun JSONObject.intOrNull(key: String): Int? {
    if (!has(key) || isNull(key)) return null
    val value = opt(key)
    return when (value) {
        is Number -> value.toInt()
        is String -> value.toIntOrNull()
        else -> null
    }
}
