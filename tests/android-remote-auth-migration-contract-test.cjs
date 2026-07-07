'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const backend = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/data/FlokiBackend.kt');
assert.match(backend, /val host: String = "api\.galactic-family-hub\.com"/);
assert.match(backend, /val port: Int = 443/);
assert.match(backend, /val useTls: Boolean = true/);
assert.match(backend, /val sessionCredential: String = ""/);
assert.match(backend, /fun normalizeFlokiSessionCredential\(value: String\): String/);
assert.match(backend, /startsWith\("Authorization:", ignoreCase = true\)/);
assert.match(backend, /startsWith\("Bearer ", ignoreCase = true\)/);
assert.match(backend, /val developerMode: Boolean = false/);
assert.match(backend, /PROFILE_SCHEMA_VERSION = 4/);
assert.match(backend, /isLoopbackHostName/);
assert.match(backend, /DEFAULT_HOST = "api\.galactic-family-hub\.com"/);
assert.match(backend, /DEFAULT_PORT = 443/);
assert.match(backend, /DEFAULT_USE_TLS = true/);
assert.match(backend, /KEY_SESSION_CREDENTIAL = "session_credential_encrypted"/);
assert.match(backend, /builder\.header\("Authorization", "Bearer \$sessionCredential"\)/);
assert.match(backend, /authenticated\(Request\.Builder\(\)\.url\(webSocketUrl\)\)/);
assert.match(backend, /Host-authorized mobile session expired/);
assert.match(backend, /suspend fun postAudio/);
assert.match(backend, /"audio\/wav"\.toMediaType\(\)/);
assert.doesNotMatch(backend, /rsiApprovalToken/);
assert.doesNotMatch(backend, /rsi_approval_token_encrypted/);
assert.doesNotMatch(backend, /put\("token"/);
assert.doesNotMatch(backend, /val host: String = "127\.0\.0\.1"/);
assert.doesNotMatch(backend, /val port: Int = 7700/);

const viewModel = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiViewModel.kt');
assert.match(viewModel, /profile\.sessionCredential\.isBlank\(\) && !profile\.developerMode/);
assert.match(viewModel, /sessionCredential = ""/);
assert.match(viewModel, /Host-authorized APK did not receive full control capabilities/);
assert.match(viewModel, /developerMode: Boolean/);
assert.match(viewModel, /Loopback profiles require Developer local profile/);
assert.match(viewModel, /fun logout\(\)/);
assert.match(viewModel, /fun sendVoice\(\)/);
assert.match(viewModel, /backend\.postAudio\("\/audio\/remote-utterance"/);
assert.doesNotMatch(viewModel, /requireRsiToken/);
assert.doesNotMatch(viewModel, /put\("token"/);

const ui = read('apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiAppRoot.kt');
assert.match(ui, /Developer local profile/);
assert.match(viewModel, /fun logout\(\)/);
assert.match(ui, /api\.galactic-family-hub\.com/);
assert.match(ui, /Manifest\.permission\.RECORD_AUDIO/);
assert.match(ui, /ActivityResultContracts\.RequestPermission/);
assert.doesNotMatch(ui, /RSI approval token/);

const manifest = read('apps/Floki-mobile-app/app/src/main/AndroidManifest.xml');
assert.match(manifest, /android\.permission\.RECORD_AUDIO/);

console.log(JSON.stringify({
  ok: true,
  marker: 'FLOKI_V2_ANDROID_REMOTE_AUTH_MIGRATION_PASS',
  production_defaults: true,
  legacy_localhost_migration: true,
  no_client_rsi_approval_token: true
}, null, 2));
