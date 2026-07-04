import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val flokiMobileAuthProperties = Properties()
val flokiMobileAuthFile =
    rootProject.file("mobile-auth.local.properties")
if (flokiMobileAuthFile.isFile) {
    flokiMobileAuthFile.inputStream().use {
        flokiMobileAuthProperties.load(it)
    }
}
val flokiMobileBootstrapSecret =
    flokiMobileAuthProperties.getProperty(
        "flokiMobileBootstrapSecret",
        ""
    ).trim()


android {
    namespace = "com.floki.neural"
    compileSdk = 37
    buildToolsVersion = "37.0.0"
    defaultConfig {
        applicationId = "com.floki.neural"
        minSdk = 26
        targetSdk = 37
        versionCode = 8
        versionName = "0.4.5-rsi-runtime-weekly-logs"
        buildConfigField(
            "String",
            "FLOKI_MOBILE_BOOTSTRAP_SECRET",
            "\"${flokiMobileBootstrapSecret}\""
        )
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        abortOnError = true
        checkDependencies = true
        warningsAsErrors = true
    }

    packaging {

        jniLibs {

            keepDebugSymbols += "**/libandroidx.graphics.path.so"

        }
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}


kotlin {
    jvmToolchain(17)
    compilerOptions {
        allWarningsAsErrors.set(true)
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.06.00")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.19.0")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    implementation("com.squareup.okhttp3:okhttp:5.4.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
