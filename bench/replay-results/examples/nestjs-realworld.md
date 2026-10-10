# Replay – nestjs-realworld-example-app – 2026-10-09 13:51 UTC

**2 commits** (each changed code and tests) · plan valid 100% · **asked for test work on 50%** of commits where the developer wrote tests · **pointed at a test file the developer changed: –** (of commits where both named files) · $0.19

| Commit | Subject | Plan | Risk | Gaps | Dev changed | Plan pointed at | Hit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 908b073e | feat: Add tag controller test | ✅ | low | 0 (skip, skip) | `src/tag/tag.controller.spec.ts` | – | – |
| e392d13d | Upgrade to version 6 | ✅ | critical | 2 (create, create, skip) | `src/tag/tag.controller.spec.ts` | – | – |

## Side by side (judge these by hand)

### 908b073e – feat: Add tag controller test

| Developer added | qa-sentinel proposed |
| --- | --- |
| TagController |  |
| findAll |  |
| should return an array of tags |  |

### e392d13d – Upgrade to version 6

| Developer added | qa-sentinel proposed |
| --- | --- |
|  | request with valid Token authorization header reaches a protected route |
|  | request without authorization header to a protected route is rejected |
|  | request with malformed or invalid token is rejected |
|  | creating an article returns a slug and 200/201 |
|  | invalid payload is rejected by the validation pipe |
|  | GET /tags returns a list |

Notes: open-source commits rarely carry acceptance criteria, so every replay runs with oracle `missing` (qa-sentinel may not claim approved behaviour). A developer not writing a test is not proof that none was needed, so only commits where the developer did write tests are replayed.
