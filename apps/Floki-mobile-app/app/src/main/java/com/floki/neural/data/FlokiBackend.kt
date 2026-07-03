package com.floki.neural.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Interceptor
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
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

/**
 * Shared OkHttpClient instance for the entire application.
 */
private val sharedClient = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(120, TimeUnit.SECONDS)
    .writeTimeout(30, TimeUnit.SECONDS)
    .pingInterval(20, TimeUnit.SECONDS)
    .retryOnConnectionFailure(true)
    .build()

data class ServerProfile(
    val host: String = "api.galactic-family-hub.com",
    val port: Int = 443,
    val pollIntervalMs: Long = 3_000L,
    val sessionCredential: String = "",
    val useTls: Boolean = true,
    val developerMode: Boolean = false
) {
    val baseUrl: String
        get() = "${if (useTls) "https" else "http"}://$host${portSuffix()}"

    val webSocketUrl: String
        get() = "${if (useTls) "wss" else "ws"}://$host${portSuffix()}/ws"

    private fun portSuffix(): String {
        val defaultPort = if (useTls) 443 else 80
        return if (port == defaultPort) "" else ":$port"
    }
}

private class AndroidKeystoreCredentialCipher {
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
                "Stored Floki session credential has an unsupported format"
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
                "Stored Floki session credential could not be decrypted",
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
    private val credentialCipher = AndroidKeystoreCredentialCipher()

    init {
        val storedHost = preferences.getString(KEY_HOST, DEFAULT_HOST)
            ?.trim()
            .orEmpty()
        val storedPort = preferences.getInt(KEY_PORT, DEFAULT_PORT)
        val storedTls = preferences.getBoolean(KEY_USE_TLS, DEFAULT_USE_TLS)
        val storedDeveloperMode = preferences.getBoolean(KEY_DEVELOPER_MODE, false)
        val mustReset =
            preferences.getInt(KEY_SCHEMA_VERSION, 0) != PROFILE_SCHEMA_VERSION ||
                isLegacyLocalEndpoint(storedHost, storedPort, storedTls, storedDeveloperMode)
        if (mustReset) {
            preferences.edit(commit = true) {
                clear()
                putInt(KEY_SCHEMA_VERSION, PROFILE_SCHEMA_VERSION)
                putString(KEY_HOST, DEFAULT_HOST)
                putInt(KEY_PORT, DEFAULT_PORT)
                putLong(KEY_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS)
                putBoolean(KEY_USE_TLS, DEFAULT_USE_TLS)
                putBoolean(KEY_DEVELOPER_MODE, false)
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
        sessionCredential = credentialCipher.decrypt(
            preferences.getString(KEY_SESSION_CREDENTIAL, "").orEmpty()
        ),
        useTls = preferences.getBoolean(KEY_USE_TLS, DEFAULT_USE_TLS),
        developerMode = preferences.getBoolean(KEY_DEVELOPER_MODE, false)
    )

    fun save(profile: ServerProfile) {
        val normalizedProfile = normalizeProfile(profile)
        val encryptedCredential = credentialCipher.encrypt(
            normalizedProfile.sessionCredential.trim()
        )
        val normalizedHost = normalizedProfile.host.trim()
        val normalizedPollInterval = profile.pollIntervalMs.coerceIn(
            1_000L,
            60_000L
        )

        preferences.edit(commit = true) {
            putInt(KEY_SCHEMA_VERSION, PROFILE_SCHEMA_VERSION)
            putString(KEY_HOST, normalizedHost)
            putInt(KEY_PORT, normalizedProfile.port)
            putLong(KEY_POLL_INTERVAL_MS, normalizedPollInterval)
            putBoolean(KEY_USE_TLS, normalizedProfile.useTls)
            putBoolean(KEY_DEVELOPER_MODE, normalizedProfile.developerMode)

            if (encryptedCredential.isBlank()) {
                remove(KEY_SESSION_CREDENTIAL)
            } else {
                putString(KEY_SESSION_CREDENTIAL, encryptedCredential)
            }
        }

        check(
            preferences.getString(KEY_HOST, null) == normalizedHost &&
                preferences.getInt(KEY_PORT, 0) == normalizedProfile.port &&
                preferences.getLong(KEY_POLL_INTERVAL_MS, 0L) == normalizedPollInterval &&
                preferences.getBoolean(KEY_USE_TLS, !normalizedProfile.useTls) ==
                    normalizedProfile.useTls &&
                preferences.getBoolean(KEY_DEVELOPER_MODE, !normalizedProfile.developerMode) ==
                    normalizedProfile.developerMode &&
                preferences.getString(KEY_SESSION_CREDENTIAL, "").orEmpty() ==
                    encryptedCredential
        ) {
            "Could not persist the Floki mobile profile"
        }
    }

    fun loadOrCreateMobileClientId(): String {
        val existing = preferences.getString(KEY_MOBILE_CLIENT_ID, "").orEmpty()
        if (existing.matches(CLIENT_ID_PATTERN)) return existing
        val next = "mobile-${UUID.randomUUID()}"
        preferences.edit(commit = true) {
            putString(KEY_MOBILE_CLIENT_ID, next)
        }
        return next
    }

    private fun normalizeProfile(profile: ServerProfile): ServerProfile {
        val host = profile.host.trim().ifBlank { DEFAULT_HOST }
        if (!isLegacyLocalEndpoint(host, profile.port, profile.useTls, profile.developerMode)) {
            return profile.copy(host = host)
        }
        return profile.copy(
            host = DEFAULT_HOST,
            port = DEFAULT_PORT,
            useTls = DEFAULT_USE_TLS,
            developerMode = false
        )
    }

    private companion object {
        const val PREFERENCES_FILE = "floki_mobile_profile_v2"
        const val PROFILE_SCHEMA_VERSION = 4
        const val KEY_SCHEMA_VERSION = "schema_version"
        const val KEY_HOST = "host"
        const val KEY_PORT = "port"
        const val KEY_POLL_INTERVAL_MS = "poll_interval_ms"
        const val KEY_SESSION_CREDENTIAL = "session_credential_encrypted"
        const val KEY_MOBILE_CLIENT_ID = "mobile_client_id"
        const val KEY_USE_TLS = "use_tls"
        const val KEY_DEVELOPER_MODE = "developer_mode"
        const val DEFAULT_HOST = "api.galactic-family-hub.com"
        const val DEFAULT_PORT = 443
        const val DEFAULT_POLL_INTERVAL_MS = 3_000L
        const val DEFAULT_USE_TLS = true
        val CLIENT_ID_PATTERN = Regex("^[A-Za-z0-9_.:-]{8,128}$")
    }
}

private fun isLegacyLocalEndpoint(
    host: String,
    port: Int,
    useTls: Boolean,
    developerMode: Boolean
): Boolean {
    if (developerMode) return false
    val normalized = host.trim().lowercase()
    return !useTls &&
        port == 7700 &&
        (normalized == "127.0.0.1" || normalized == "localhost")
}

class FlokiHttpException(message: String) : IOException(message)

class FlokiBackend(profile: ServerProfile) {
    private val baseUrl = profile.baseUrl
    private val webSocketUrl = profile.webSocketUrl
    private val sessionCredential = profile.sessionCredential.trim()

    /**
     * Authenticated client that attaches the approved-user Bearer session.
     */
    private val client = sharedClient.newBuilder()
        .addInterceptor(Interceptor { chain ->
            val original = chain.request()
            if (sessionCredential.isBlank()) return@Interceptor chain.proceed(original)

            val builder = original.newBuilder()
            builder.header("Authorization", "Bearer $sessionCredential")
            chain.proceed(builder.build())
        })
        .build()

    private fun authenticated(builder: Request.Builder): Request.Builder {
        if (sessionCredential.isNotBlank()) {
            builder.header("Authorization", "Bearer $sessionCredential")
        }
        return builder
    }

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

    suspend fun postAudio(path: String, wavBytes: ByteArray): JSONObject =
        withContext(Dispatchers.IO) {
            require(wavBytes.isNotEmpty()) { "Voice audio payload cannot be empty" }
            val request = Request.Builder()
                .url(url(path))
                .post(wavBytes.toRequestBody("audio/wav".toMediaType()))
                .build()
            parseObject(execute(request))
        }

    fun openEvents(
        onOpen: () -> Unit,
        onMessage: (String) -> Unit,
        onFailure: (String) -> Unit,
        onClosed: () -> Unit
    ): WebSocket {
        val request = authenticated(Request.Builder().url(webSocketUrl)).build()
        return client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = onMessage(text)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onFailure(t.message ?: "WebSocket connection failed")
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onClosed()
        })
    }

    fun visionFrameUrl(): String = "$baseUrl/interface/vision/frame/latest.jpg"

    suspend fun getBytes(path: String): ByteArray = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(url(path)).get().build()).execute().use { response ->
            if (!response.isSuccessful) {
                throw FlokiHttpException("HTTP ${response.code} for $path")
            }
            response.body.bytes()
        }
    }

    fun close() {
        // Individual Backend instances use a shared pool but have their own Interceptor client wrapper.
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
