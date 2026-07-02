# Floki Mobile Android

Current build toolchain:

- Gradle 9.6.1
- Android Gradle Plugin 9.2.1
- Kotlin/Compose compiler 2.3.10
- compileSdk 36
- targetSdk 36
- Android SDK Build Tools 36.0.0
- Gradle runtime: Java 25
- Android bytecode target: Java 17

# Floki Mobile Android Client

This Android project connects to the current Floki-v2 `chat.local` runtime contract.

## Runtime routes used

- `GET /interface/status`
- `GET /interface/services`
- `GET /interface/transcript`
- `GET /interface/dreams`
- `GET /interface/neural`
- `GET /interface/sleep`
- `POST /chat`
- `POST /interface/control/{action}`
- `GET/POST /self-improvement/*`
- `WS /ws`

The app does not call `/client-ready` or `/client-detached`.

## USB connection

Floki-v2 currently binds to `127.0.0.1:7700`. Connect the phone with USB debugging enabled and run:

```bash
adb reverse tcp:7700 tcp:7700
```

Keep the app profile set to host `127.0.0.1`, port `7700`.

## Build

```bash
./gradlew clean :app:assembleDebug
```

APK output:

```text
app/build/outputs/apk/debug/app-debug.apk
```
