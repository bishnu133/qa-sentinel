### QA impact – notifications-service · 🟠 High risk

**Verdict:** 3 changes, 2 uncovered requirement gaps (AC-1, AC-2), 1 undocumented response change, spec drift; AC-3 belongs to a later orders-service MR

**Recommended QA action:** Add tests for template/trackingNumber validation (AC-1, AC-2); ask the PO whether the new response fields should be documented in openapi.yaml; verify AC-3 in the orders-service MR.

| Change | Risk | Oracle | Coverage | Decision |
| --- | --- | --- | --- | --- |
| POST /notifications – Optional template 'order-shipped' is accepted and then requires trackingNumber (400 otherwise) (AC-1) | 🟠 High | approved | missing | **create** |
| POST /notifications – Unknown template values are rejected with 400 'unknown template' (AC-2) | 🟡 Medium | approved | missing | **create** |
| POST /notifications – 202 response body (and stored notification) now includes template and trackingNumber | 🟠 High | missing | missing | **review** |

**Run these existing tests**
- `tests/api/notifications/notifications.spec.ts` – existing POST /notifications tests send no template and remain valid

**Missing or outdated scenarios**
- queues a notification with template order-shipped and a trackingNumber (AC-1) – create
- returns 400 when template order-shipped has no trackingNumber (AC-1) – create
- returns 400 for an unknown template (AC-2) – create

**Contract changes (computed from `openapi.yaml`, base → head):** the spec is unchanged in this diff.

**Spec drift** (code vs spec)
- template and trackingNumber are accepted by POST /notifications in code but absent from openapi.yaml

**Open questions**
- AC-3 (shipping an order sends exactly one order-shipped notification) is implemented in a later orders-service MR and is not verifiable from this diff.
- Story approval is unverified; confirm the acceptance criteria are approved.

<details><summary>Evidence (3 changes)</summary>

- **c1** validation-change POST /notifications – Optional template 'order-shipped' is accepted and then requires trackingNumber (400 otherwise)
  - risk high from: validation, business-rule
  - source-code: `src/server.js:19` – if (template === "order-shipped" && !trackingNumber) return res.status(400).json({ error: "trackingNumber is required" })
  - requirement: AC-1: POST /notifications accepts an optional "template": "order-shipped" and then requires "trackingNumber"
- **c2** validation-change POST /notifications – Unknown template values are rejected with 400 'unknown template'
  - risk medium from: validation
  - source-code: `src/server.js:18` – if (template !== undefined && !TEMPLATES.includes(template)) return res.status(400).json({ error: "unknown template" })
  - requirement: AC-2: Unknown templates -> 400
- **c3** contract-change POST /notifications – 202 response body (and stored notification) now includes template and trackingNumber
  - risk high from: non-breaking-contract, cross-service
  - source-code: `src/server.js:20` – const n = { id, orderId, channel, message, template, trackingNumber, status: "queued" }
  - contract-diff: the spec is unchanged in this diff
- decision c1: create – no existing test sends a template or trackingNumber
  - existing-test: `tests/api/notifications/notifications.spec.ts:3` – POST /notifications tests only cover a plain email notification and an unknown channel; none send template
- decision c2: create – unknown-template validation has no test
  - existing-test: `tests/api/notifications/notifications.spec.ts:12` – only the unknown channel 400 is tested; unknown template is not
- decision c3: review – no requirement or contract describes the new response fields; a human should decide whether they are part of the contract
  - contract-diff: the spec is unchanged in this diff, so the new response fields are undocumented

</details>

**Requirements:** SHOP-106 from [story-file](<work>/stories/SHOP-106.md) @ sha256:63cae439e4dcf6f2 · 3 AC parsed · approval unverified

<sub>qa-sentinel 0.2.0 gap report · notifications-service@f2c71a2b · 11 turns · 40s · $0.11</sub>
