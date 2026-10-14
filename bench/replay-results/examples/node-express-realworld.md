# Replay – node-express-realworld-example-app – 2026-10-09 13:52 UTC

**1 commits** (each changed code and tests) · plan valid 100% · **asked for test work on 100%** of commits where the developer wrote tests · **pointed at a test file the developer changed: –** (of commits where both named files) · $0.24

| Commit | Subject | Plan | Risk | Gaps | Dev changed | Plan pointed at | Hit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5eeccf13 | chore: update to latest demo version | ✅ | critical | 6 (create, create, create, create, create, review, skip) | `src/tests/services/article.service.test.ts`<br>`src/tests/services/auth.service.test.ts`<br>`src/tests/services/profile.service.test.ts`<br>`src/tests/utils/profile.utils.test.ts` | – | – |

## Side by side (judge these by hand)

### 5eeccf13 – chore: update to latest demo version

| Developer added | qa-sentinel proposed |
| --- | --- |
|  | login returns a token that authenticates GET /user |
|  | login with wrong password is rejected |
|  | non-author cannot update an article |
|  | non-author cannot delete an article |
|  | author can update and delete own article |
|  | only the comment author can delete a comment |
|  | GET /user returns the current user |
|  | PUT /user updates bio and keeps the session valid |
|  | GET /user without a token is rejected |
|  | favorite and unfavorite toggle favorited and favoritesCount |
|  | follow and unfollow set profile and article author following flag |
|  | feed lists only articles by followed authors |
|  | authenticated list includes the caller's own non-demo articles |
|  | comments and tags of the caller are returned |

Notes: open-source commits rarely carry acceptance criteria, so every replay runs with oracle `missing` (qa-sentinel may not claim approved behaviour). A developer not writing a test is not proof that none was needed, so only commits where the developer did write tests are replayed.
