'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8');

const backend = read(
  'apps/Floki-mobile-app/app/src/main/java/com/floki/neural/data/FlokiBackend.kt'
);
const bootstrap = read(
  'apps/Floki-mobile-app/app/src/main/java/com/floki/neural/data/MobileBootstrapAuth.kt'
);
const vm = read(
  'apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiViewModel.kt'
);
const ui = read(
  'apps/Floki-mobile-app/app/src/main/java/com/floki/neural/ui/FlokiAppRoot.kt'
);
const gradle = read(
  'apps/Floki-mobile-app/app/build.gradle.kts'
);
const ignore = read(
  'apps/Floki-mobile-app/.gitignore'
);

assert.match(
  bootstrap,
  /BuildConfig\.FLOKI_MOBILE_BOOTSTRAP_SECRET/
);
assert.match(bootstrap, /HmacSHA256/);
assert.match(bootstrap, /X-Floki-Device-Id/);
assert.match(bootstrap, /X-Floki-Timestamp/);
assert.match(bootstrap, /X-Floki-Nonce/);
assert.match(bootstrap, /X-Floki-Signature/);
assert.match(
  bootstrap,
  /wp-json\/floki-mobile\/v1\/session/
);
assert.doesNotMatch(bootstrap, /CustomTabsIntent/);
assert.doesNotMatch(bootstrap, /code_challenge/);
assert.doesNotMatch(bootstrap, /redirect_uri/);

assert.match(
  backend,
  /open class FlokiHttpException/
);
assert.match(
  backend,
  /class FlokiUnauthorizedException/
);
assert.match(
  backend,
  /accessCredential: String/
);
assert.doesNotMatch(
  backend,
  /paste the raw gateway token/
);

assert.match(vm, /bootstrapAndStart/);
assert.match(vm, /MobileBootstrapAuth/);
assert.match(vm, /transportAuthenticated/);
assert.match(vm, /startMobileHeartbeat\(generation\)/);
assert.match(vm, /recoverUnauthorized/);
assert.match(vm, /tokenRefreshJob/);
assert.doesNotMatch(vm, /beginMobileLogin/);
assert.doesNotMatch(vm, /handleAuthCallback/);

assert.match(
  ui,
  /HOST-AUTHORIZED APK/
);
assert.match(
  ui,
  /No login or token entry is required/
);
assert.doesNotMatch(
  ui,
  /Approved-user session credential/
);
assert.doesNotMatch(
  ui,
  /PasswordVisualTransformation/
);
assert.doesNotMatch(
  ui,
  /SIGN IN WITH APPROVED ACCOUNT/
);

assert.match(
  gradle,
  /FLOKI_MOBILE_BOOTSTRAP_SECRET/
);
assert.match(
  gradle,
  /mobile-auth\.local\.properties/
);
assert.match(
  ignore,
  /mobile-auth\.local\.properties/
);

console.log(
  'FLOKI_ANDROID_HOST_AUTHORIZED_APK_CONTRACT_PASS'
);
