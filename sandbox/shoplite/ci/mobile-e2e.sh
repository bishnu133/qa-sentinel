#!/usr/bin/env bash
# CI proof of the mobile layer on a real Android emulator (run inside reactivecircus/android-emulator-runner):
# build the ShopLite app, start the ShopLite QA environment and Appium, run the sandbox's app tests, then make
# the SHOP-109 change and check that qa-sentinel's verification sees the broken test as FAILED (not BLOCKED).
set -euo pipefail
W="${1:?work folder}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
L="node $ROOT/sandbox/shoplite/local.mjs"

$L app build --work "$W"
$L env start --work "$W"
appium --log-level warn > "$W/appium.log" 2>&1 &
for _ in $(seq 1 45); do curl -sf http://127.0.0.1:4723/status >/dev/null && break; sleep 2; done
curl -sf http://127.0.0.1:4723/status >/dev/null || { echo "Appium did not start"; cat "$W/appium.log"; exit 1; }
adb devices

export QA_MOBILE_PLATFORM=android QA_APP="$W/shoplite-app/build/shoplite.apk" QA_BASE_URL=http://127.0.0.1:8080
cd "$W/qa-tests"
echo "::group::baseline app tests"
npx wdio run wdio.conf.ts
echo "::endgroup::"
ls -la test-results/mobile
ls test-results/mobile/*.mp4 test-results/mobile/*.result.json >/dev/null

echo "::group::qa-sentinel verify on a changed app test (should be VERIFIED)"
sed -i 's/places an order and lands on its order screen/places an order and opens it/' tests/mobile/orders/new-order.spec.ts
node "$ROOT/dist/cli.js" verify --base HEAD --out "$W/verify.md" || { cat "$W/verify.md"; exit 1; }
git checkout -q -- tests/mobile/orders/new-order.spec.ts
echo "::endgroup::"
echo "✓ mobile layer: app built, tests passed on the emulator, recordings written, verification VERIFIED"
