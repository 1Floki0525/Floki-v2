# Floki Mobile Android

Current build toolchain:

- Gradle 9.6.1
- Android Gradle Plugin 9.2.1
- Kotlin/Compose compiler 2.3.10
- compileSdk 37
- targetSdk 37
- Android SDK Build Tools 37.0.0
- Gradle runtime: Java 17
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

## Production connection

Production defaults connect to the public gateway:

- API: `https://api.galactic-family-hub.com`
- WebSocket: `wss://api.galactic-family-hub.com/ws`
- Port: `443`

Stored legacy `127.0.0.1:7700` profiles migrate to the production default on app start.

## USB development connection

Loopback profiles are available only after enabling **Developer local profile** in app settings. Connect the phone with USB debugging enabled and run:

```bash
adb reverse tcp:7700 tcp:7700
```

Then set the app profile to host `127.0.0.1`, port `7700`, secure off.

## Build

```bash
./gradlew clean :app:assembleDebug
```

APK output:

```text
app/build/outputs/apk/debug/app-debug.apk
```
