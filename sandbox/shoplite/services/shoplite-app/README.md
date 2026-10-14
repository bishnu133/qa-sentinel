# ShopLite app (Android, sandbox)

A small native Android app for qa-sentinel's mobile layer: home → new order → order screen, talking to the ShopLite API through the QA environment's gateway (`http://10.0.2.2:8080` from the emulator). Every element tests use has a content description (Appium accessibility id).

- Build: `./build.sh` → `build/shoplite.apk` (plain SDK tools: javac, d8, aapt2, zipalign, apksigner; no Gradle).
- Deep link: `shoplite://orders/<id>` opens an order.
