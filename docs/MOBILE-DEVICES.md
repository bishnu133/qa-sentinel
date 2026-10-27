# Mobile: iOS and device farms (code side only)

**Status: not proven.** The code and checks described here exist and are unit-tested with mock servers and fake commands. Nothing has been run on a Mac, an iOS simulator, an iOS device or any device farm. If something fails, that is expected feedback: report it.

qa-sentinel talks to an Appium server. Anything that gives you an Appium URL (your laptop, a Mac, a farm) can run the suite. qa-sentinel does **not** call any farm's own API (no app upload, no session links, no reporters) and has no vendor SDK.

## The pieces

| What | Where |
|---|---|
| Appium URL (credentials in the URL are sent as a header, never printed) | `QA_APPIUM_URL` |
| Platform | `QA_MOBILE_PLATFORM=ios` or `android` |
| App to install, or an installed app | `QA_APP` (.apk/.app/.ipa, path or URL), or `QA_BUNDLE_ID` (iOS) / `QA_APP_PACKAGE` + `QA_APP_ACTIVITY` (Android) |
| Device | `QA_DEVICE_NAME`, `QA_PLATFORM_VERSION`, `QA_UDID` |
| A farm's own block | `QA_APPIUM_CAPS`: one JSON object, merged over the capabilities. Copy it from your farm's documentation, for example `{"bstack:options":{"userName":"...","accessKey":"..."}}`. It can hold a key, so qa-sentinel never prints it (also not in error messages) and does not give it to the AI agent or an external engine. |
| No recording by qa-sentinel (the farm records) | `QA_VIDEO=off` |

`wdio.conf.ts` reads these. A project made before this release has an older `wdio.conf.ts` without `QA_APPIUM_CAPS`; `doctor` warns, and you add the merge shown in `templates/scaffold/wdio-mobile/wdio.conf.ts.tmpl`.

## Where the farm login goes

A farm's login can sit in the Appium URL (`https://USER:KEY@hub/wd/hub`) or in `QA_APPIUM_CAPS`. qa-sentinel treats both as secrets for **its own** runs only (verification, `mobile-run`, screen snapshots): they are sent as a header or in the session request, and removed from error messages and files. The AI agent and an external engine get `QA_APPIUM_URL` **without** the login, and no `QA_APPIUM_CAPS`. So the agent's own trial runs on a farm cannot sign in: it writes the tests, qa-sentinel runs them. If you accept that the agent holds the key, set `tests.auth.shareWithAgent: true`.

## Targets and `mobile-run`

Write down how to run the suite on each platform or farm, once:

```yaml
tests:
  mobile:
    targets:
      ios-sim:
        platform: ios
        env: { QA_BUNDLE_ID: com.example.shop }            # plain values only
      farm:
        platform: android
        runCommand: "npx wdio run wdio.conf.ts"             # your command; default is tests.mobile.runCommand
        env: { QA_DEVICE_NAME: "Pixel 7" }
        passEnv: [QA_APPIUM_URL, QA_APPIUM_CAPS, QA_APP]    # taken from your environment; must be set; never printed
```

```
qa-sentinel mobile-run --target farm --dry-run     # shows the command and the variable names
qa-sentinel mobile-run --target farm --spec tests/mobile/orders/new.spec.ts
```

`QA_APPIUM_CAPS` is always shown as `***`, also when you put it in a target's `env` (use `passEnv`).

It runs your command with `--spec <file>` for each file, with the cleaned test environment plus the target's `env` and `passEnv`, inside `verification.wrapCommand` if you set one. The exit code is the command's. It stops with a list of problems (names only) if a `passEnv` variable is missing, `QA_APPIUM_CAPS` is not one JSON object, or no app is given.

## iOS limits

- `doctor` says "iOS runs are not proven yet" whenever iOS is the platform or a target.
- iOS needs a Mac (simulators or devices) or a farm. `doctor` warns when this machine is not a Mac and no `QA_APPIUM_URL` is set.
- **Deep links on iOS are not supported yet.** `openDeepLink` in the screen objects throws a clear error on iOS, and screen snapshots refuse an iOS deep link. Reason: the Appium XCUITest driver's `mobile: deepLink` command was not confirmed against the driver's official documentation (it could not be opened while this was written; forum posts mention it, reliable from iOS 16.4). Reach screens through the UI on iOS. To add it later, check the XCUITest driver's "execute methods" page for `mobile: deepLink` first.
- Screen snapshots on iOS save the screen the app opens on (`launch`).

## App screen snapshots

`tests.mobile.explore: snapshot` (default `none`). During `generate`, before the AI writes mobile tests, qa-sentinel opens the affected screens on a device and saves the accessibility tree, a short list of ids and a screenshot in the run folder (`screen-snapshots/`), then points the agent at them. It needs Appium, a device and an app (`QA_APP`, `QA_APP_PACKAGE` or `QA_BUNDLE_ID`) at that moment. If anything fails the run continues with a warning.

- `tests.mobile.deepLinkBase: "myapp://"` makes the screen `orders/new` open as `myapp://orders/new` (Android). Without it only the screen the app opens on is saved.
- A screen name with a parameter (`orders/:id`) is listed as not opened.
- Only one moment of each screen is saved: lists, dialogs and anything behind a tap are not in it.
- Calls used: `POST /session`, `GET /session/:id/source`, `GET /session/:id/screenshot`, `POST /session/:id/execute/sync` (Android deep link), `DELETE /session/:id`. Tested against a mock server only.
