#!/usr/bin/env bash
# Builds build/shoplite.apk with the plain Android SDK tools (no Gradle, no downloads):
# javac → d8 → aapt2 → zipalign → apksigner. Needs ANDROID_HOME (or ANDROID_SDK_ROOT) with one
# platforms;android-NN and one build-tools;NN installed (Android Studio › Settings › Android SDK), and a JDK.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
# Latest final releases only (not 36.0.0-rc1 or android-Baklava previews).
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | grep -E '/[0-9]+(\.[0-9]+)*$' | sort -V | tail -1 || true)"
PLAT="$(ls -d "$SDK"/platforms/android-* 2>/dev/null | grep -E '/android-[0-9]+$' | sort -V | tail -1 || true)"
if [ -z "$BT" ] || [ -z "$PLAT" ]; then
  echo "✗ Android SDK build-tools or platform not found in $SDK." >&2
  echo "  Android Studio › Settings › Languages & Frameworks › Android SDK: tick an 'Android SDK Platform' (SDK Platforms tab)" >&2
  echo "  and 'Android SDK Build-Tools' (SDK Tools tab), then Apply. Or: sdkmanager \"platforms;android-34\" \"build-tools;34.0.0\"" >&2
  exit 2
fi
JAVAC="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
KEYTOOL="${JAVA_HOME:+$JAVA_HOME/bin/}keytool"
rm -rf build/classes build/dex build/*.apk
mkdir -p build/classes build/dex
"$JAVAC" -encoding UTF-8 -nowarn -source 8 -target 8 -bootclasspath "$PLAT/android.jar" -d build/classes $(find src -name '*.java') 2>&1 | grep -v "warning: \[options\]" || true
[ -n "$(find build/classes -name '*.class' | head -1)" ] || { echo "✗ javac failed" >&2; exit 1; }
"$BT/d8" --min-api 24 --lib "$PLAT/android.jar" --output build/dex $(find build/classes -name '*.class')
"$BT/aapt2" link -o build/unsigned.apk -I "$PLAT/android.jar" --manifest AndroidManifest.xml --min-sdk-version 24 --target-sdk-version 34 --version-code 1 --version-name 1.0
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
[ -f build/debug.keystore ] || "$KEYTOOL" -genkeypair -keystore build/debug.keystore -storepass android -keypass android -alias debug -dname "CN=ShopLite Debug" -keyalg RSA -validity 10000 >/dev/null 2>&1
"$BT/apksigner" sign --ks build/debug.keystore --ks-pass pass:android --out build/shoplite.apk build/aligned.apk
echo "✓ $(pwd)/build/shoplite.apk"
