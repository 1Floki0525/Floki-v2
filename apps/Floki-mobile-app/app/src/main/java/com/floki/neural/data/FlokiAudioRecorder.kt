package com.floki.neural.data

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.math.max

class FlokiAudioRecorder {
    @SuppressLint("MissingPermission")
    suspend fun recordWav(durationMs: Long = 5_000L): ByteArray = withContext(Dispatchers.IO) {
        val sampleRate = 16_000
        val channelMask = AudioFormat.CHANNEL_IN_MONO
        val encoding = AudioFormat.ENCODING_PCM_16BIT
        val minBuffer = AudioRecord.getMinBufferSize(sampleRate, channelMask, encoding)
        require(minBuffer > 0) { "Android microphone buffer is unavailable" }

        val audioFormat = AudioFormat.Builder()
            .setSampleRate(sampleRate)
            .setChannelMask(channelMask)
            .setEncoding(encoding)
            .build()
        val recorder = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(audioFormat)
            .setBufferSizeInBytes(max(minBuffer, sampleRate))
            .build()
        val pcm = ByteArrayOutputStream()
        val buffer = ByteArray(max(minBuffer, 4096))
        try {
            recorder.startRecording()
            val deadline = System.currentTimeMillis() + durationMs.coerceIn(500L, 15_000L)
            while (System.currentTimeMillis() < deadline) {
                val read = recorder.read(buffer, 0, buffer.size)
                if (read > 0) pcm.write(buffer, 0, read)
            }
        } finally {
            runCatching { recorder.stop() }
            recorder.release()
        }
        val bytes = pcm.toByteArray()
        require(bytes.size > 44) { "No microphone audio samples were captured" }
        wav(bytes, sampleRate, channels = 1, bitsPerSample = 16)
    }

    suspend fun playWav(wavBytes: ByteArray) = withContext(Dispatchers.IO) {
        val wav = parseWav(wavBytes)
        val channelMask = if (wav.channels == 1) {
            AudioFormat.CHANNEL_OUT_MONO
        } else {
            AudioFormat.CHANNEL_OUT_STEREO
        }
        val audioFormat = AudioFormat.Builder()
            .setSampleRate(wav.sampleRate)
            .setChannelMask(channelMask)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .build()
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(audioFormat)
            .setBufferSizeInBytes(wav.pcm.size)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        try {
            track.play()
            track.write(wav.pcm, 0, wav.pcm.size)
            delay(wav.durationMs + 100L)
        } finally {
            runCatching { track.stop() }
            track.release()
        }
    }

    private fun wav(
        pcm: ByteArray,
        sampleRate: Int,
        channels: Int,
        bitsPerSample: Int
    ): ByteArray {
        val out = ByteArrayOutputStream(44 + pcm.size)
        out.writeAscii("RIFF")
        out.writeIntLe(36 + pcm.size)
        out.writeAscii("WAVE")
        out.writeAscii("fmt ")
        out.writeIntLe(16)
        out.writeShortLe(1)
        out.writeShortLe(channels)
        out.writeIntLe(sampleRate)
        out.writeIntLe(sampleRate * channels * bitsPerSample / 8)
        out.writeShortLe(channels * bitsPerSample / 8)
        out.writeShortLe(bitsPerSample)
        out.writeAscii("data")
        out.writeIntLe(pcm.size)
        out.write(pcm)
        return out.toByteArray()
    }

    private data class ParsedWav(
        val sampleRate: Int,
        val channels: Int,
        val durationMs: Long,
        val pcm: ByteArray
    )

    private fun parseWav(bytes: ByteArray): ParsedWav {
        require(bytes.size >= 44) { "Piper response audio is not a WAV file" }
        require(bytes.ascii(0, 4) == "RIFF" && bytes.ascii(8, 12) == "WAVE") {
            "Piper response audio is not RIFF/WAVE"
        }
        var sampleRate = 0
        var channels = 0
        var byteRate = 0
        var pcm = ByteArray(0)
        var offset = 12
        while (offset + 8 <= bytes.size) {
            val id = bytes.ascii(offset, offset + 4)
            val size = bytes.intLe(offset + 4)
            val start = offset + 8
            val end = start + size
            require(end <= bytes.size) { "Piper response WAV chunk exceeds file length" }
            if (id == "fmt " && size >= 16) {
                channels = bytes.shortLe(start + 2)
                sampleRate = bytes.intLe(start + 4)
                byteRate = bytes.intLe(start + 8)
            }
            if (id == "data") {
                pcm = bytes.copyOfRange(start, end)
            }
            offset = end + (size % 2)
        }
        require(sampleRate > 0 && channels in 1..2 && byteRate > 0 && pcm.isNotEmpty()) {
            "Piper response WAV is missing playable PCM data"
        }
        return ParsedWav(
            sampleRate = sampleRate,
            channels = channels,
            durationMs = (pcm.size.toLong() * 1000L / byteRate.toLong()).coerceAtLeast(100L),
            pcm = pcm
        )
    }
}

private fun ByteArrayOutputStream.writeAscii(value: String) {
    write(value.toByteArray(Charsets.US_ASCII))
}

private fun ByteArrayOutputStream.writeShortLe(value: Int) {
    write(value and 0xff)
    write((value ushr 8) and 0xff)
}

private fun ByteArrayOutputStream.writeIntLe(value: Int) {
    write(value and 0xff)
    write((value ushr 8) and 0xff)
    write((value ushr 16) and 0xff)
    write((value ushr 24) and 0xff)
}

private fun ByteArray.ascii(start: Int, end: Int): String =
    copyOfRange(start, end).toString(Charsets.US_ASCII)

private fun ByteArray.shortLe(offset: Int): Int =
    (this[offset].toInt() and 0xff) or
        ((this[offset + 1].toInt() and 0xff) shl 8)

private fun ByteArray.intLe(offset: Int): Int =
    (this[offset].toInt() and 0xff) or
        ((this[offset + 1].toInt() and 0xff) shl 8) or
        ((this[offset + 2].toInt() and 0xff) shl 16) or
        ((this[offset + 3].toInt() and 0xff) shl 24)
