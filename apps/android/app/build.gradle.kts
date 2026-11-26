import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// A build is numbered by its time (UTC, yyyymmddHHMM, as the Apple app's are): its version code is the minutes since
// 2026 began, so a later build always installs over an earlier one. Without one it is a developer's build, code 1.
val build: String? = providers.gradleProperty("invincible.build").orNull
val stamp = DateTimeFormatter.ofPattern("yyyyMMddHHmm")
val code = build?.let { ((LocalDateTime.parse(it, stamp).toEpochSecond(ZoneOffset.UTC) - 1_767_225_600L) / 60).toInt() } ?: 1

// The release key lives outside the repository: scripts/release.sh hands its path and password over in the environment.
val keystore: String? = providers.environmentVariable("INVINCIBLE_ANDROID_KEYSTORE").orNull

android {
    namespace = "sh.invincible.bot"
    compileSdk = 37
    // Compose 1.13 (material3 1.5, Material 3 Expressive) compiles against 37.1 or later.
    compileSdkMinor = 2
    defaultConfig {
        applicationId = "sh.invincible.bot"
        minSdk = 29
        targetSdk = 36
        versionCode = code
        versionName = "0.1.0" + (build?.let { " ($it)" } ?: "-dev")
    }
    buildFeatures {
        compose = true
        buildConfig = false
    }
    androidResources {
        // Its words are English: the libraries' other languages would only make it bigger.
        localeFilters += "en"
    }
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = providers.environmentVariable("INVINCIBLE_ANDROID_KEYSTORE_PASSWORD").get()
                keyAlias = "invincible"
                keyPassword = providers.environmentVariable("INVINCIBLE_ANDROID_KEYSTORE_PASSWORD").get()
                storeType = "PKCS12"
            }
        }
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = " debug"
        }
        release {
            optimization { enable = true }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets {
        // (No pictures of the agents: each is an orb of glyphs it draws itself, ui/Orb.kt. Its mark is a vector drawable.)
        // The parity vectors the Apple app is held to, read where they are: this app is held to the same bytes.
        getByName("test").resources.srcDir("../../apple/InvincibleTests/Fixtures")
    }
    packaging {
        resources {
            excludes += setOf("META-INF/*.version", "META-INF/**/*.kotlin_module", "kotlin/**", "**/*.kotlin_builtins", "DebugProbesKt.bin")
        }
    }
    // Nothing about its libraries goes into the app for a store to read: what it's built from is in this repository.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.11.01"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("androidx.profileinstaller:profileinstaller:1.4.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
}
