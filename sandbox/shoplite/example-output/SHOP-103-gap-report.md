### QA impact – notifications-service · 🟠 High risk

**Verdict:** 1 requirement conflict (AC-3), 3 outdated tests – channel was removed without a compatibility path

**Recommended QA action:** Update notifications.spec.ts to use medium and add legacy-channel scenarios; ask the PO how AC-3 'existing consumers keep working' is met (alias, deprecation window, or accepted break).

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| POST /notifications – Request field channel renamed to medium (required, enum email\|sms); validation error now names medium (AC-1) | 🟠 High | approved | outdated | **update** |
| POST /notifications – 202 response returns medium instead of channel (AC-2) | 🟠 High | approved | outdated | **update** |
| GET /notifications – List response items return medium instead of channel (AC-2) | 🟠 High | approved | outdated | **update** |
| POST /notifications – channel is no longer accepted or returned and no alias exists, so existing consumers sending channel get 400 (AC-3) | 🟠 High | conflicting | missing | **review** |

**Run these existing tests**
- `tests/api/notifications/notifications.spec.ts` – all three tests send or assert channel ⚠️ will fail or no longer proves the behaviour

**Missing or outdated scenarios**
- queues an email notification using medium (AC-1) – update
- returns 400 for an unknown medium (AC-1) – update
- returns 400 when medium is missing (AC-1) – update
- 202 response body contains medium and no channel (AC-2) – update
- lists notifications with medium on each item (AC-2) – update
- legacy request with channel still works (written to AC-3, fixme until resolved) (AC-3) – review

**Requirement conflicts – need a human decision**
- ⚠️ AC-3: requirement says "Existing consumers keep working"; observed: channel is removed from requests and responses with no alias; requests with channel return 400 (`src/server.js:14` – if (!MEDIUMS.includes(medium)) return res.status(400))

**Contract changes (computed from `openapi.yaml`, base → head):**

| Impact | Endpoint | Change | Where | Detail |
| --- | --- | --- | --- | --- |
| compatible | GET /notifications | field-added | `response.200.body[].medium` | required |
| ⚠️ breaking | GET /notifications | field-removed | `response.200.body[].channel` | removed |
| ⚠️ breaking | POST /notifications | field-added | `request.body.medium` | required |
| compatible | POST /notifications | field-removed | `request.body.channel` | removed |
| compatible | POST /notifications | field-added | `response.202.body.medium` | required |
| ⚠️ breaking | POST /notifications | field-removed | `response.202.body.channel` | removed |

**Open questions**
- AC-3: should channel remain accepted as a deprecated alias, or is the break accepted and consumers migrated?
- Do orders-service or other consumers call POST /notifications with channel?

<details><summary>Evidence (4 changes)</summary>

- **c1** contract-change POST /notifications – Request field channel renamed to medium (required, enum email|sms); validation error now names medium
  - risk high from: breaking-contract, validation, cross-service
  - source-code: `src/server.js:14` – if (!MEDIUMS.includes(medium)) return res.status(400).json({ error: `medium must be one of ...` })
  - contract-diff: POST /notifications field-added request.body.medium (breaking, required)
  - requirement: AC-1: POST /notifications accepts "medium" (email | sms) instead of "channel"
- **c2** contract-change POST /notifications – 202 response returns medium instead of channel
  - risk high from: breaking-contract, cross-service
  - source-code: `src/server.js:16` – const n = { id, orderId, medium, message, status: "queued" }
  - contract-diff: POST /notifications field-removed response.202.body.channel (breaking)
  - requirement: AC-2: Responses return "medium"
- **c3** contract-change GET /notifications – List response items return medium instead of channel
  - risk high from: breaking-contract, read-only, cross-service
  - contract-diff: GET /notifications field-removed response.200.body[].channel (breaking)
  - requirement: AC-2: Responses return "medium"
- **c4** contract-change POST /notifications – channel is no longer accepted or returned and no alias exists, so existing consumers sending channel get 400
  - risk high from: breaking-contract, conflicting-oracle, cross-service
  - source-code: `src/server.js:14` – only medium is validated; a body with channel and no medium fails the MEDIUMS check
  - contract-diff: POST /notifications request.body.medium added as required; GET/POST responses drop channel (breaking)
  - requirement: AC-3: Existing consumers keep working
- decision c1: update – existing POST tests send channel, which the service now rejects
  - existing-test: `tests/api/notifications/notifications.spec.ts:5` – posts channel: "email" and expects success; now gets 400
- decision c2: update – existing assertion reads body.channel, which is no longer returned
  - existing-test: `tests/api/notifications/notifications.spec.ts:9` – expect(body.channel).toBe("email")
- decision c3: update – GET test setup uses channel and does not assert the renamed response field
  - existing-test: `tests/api/notifications/notifications.spec.ts:21` – setup posts channel: "sms"; the filter test would fail on setup
- decision c4: review – AC-3 conflicts with the code and with the breaking contract diff; a human must decide the intended compatibility behaviour
  - source-code: `src/server.js:14` – no fallback from channel to medium

</details>

**Requirements:** SHOP-103 from [story-file](<work>/stories/SHOP-103.md) @ sha256:115e09457ff76a4e · 3 AC parsed · approval unverified

<sub>qa-sentinel 0.2.0 gap report · notifications-service@ad472296 · 11 turns · 40s · $0.12</sub>
