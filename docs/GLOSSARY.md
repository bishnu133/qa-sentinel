# Glossary

The words qa-sentinel uses in reports, merge requests and Jira, so QA, developers and POs read them the same way.

## Requirements

| Term | Meaning |
| --- | --- |
| **AC** | An acceptance criterion of the story (AC-1, AC-2, …). The oracle: tests check the product against it. |
| **Scope item** | A requirement written outside the ACs (IS-1 in scope, TS-1 tech note, ER-1 expected result). A weaker oracle than an AC. |
| **Expected behaviour** | `expected/<STORY>.md`: what each AC means in testable terms (values, boundaries, negative cases). Written from the story alone, reviewed by QA. |
| **Behaviour id** | B1, B2, … in the expected file. Stable within the story, never reused: `SHOP-101/B3`. |
| **ready** | Tests assert it. Written by the requirements pass or by QA; QA approves it by merging the merge request. |
| **needs-review** | The AC changed after the behaviour was written. Not tested until QA sets it back to ready. |
| **unspecified** | The story doesn't give the value. A question goes to the PO; nothing is invented, nothing is tested until answered. |
| **Requirements pass** | The code-blind AI run that writes expected behaviour from the story (`qa-sentinel spec`, first step of `generate`). |
| **Clarification** | A value agreed outside Jira (call, chat), recorded with who, when and a link. |

## Protection

| Term | Meaning |
| --- | --- |
| **Expectation lock** | An AI run may not change, weaken, switch off or remove a requirement test or its expected behaviour while the AC is unchanged. |
| **QA override** | A person changed a locked expectation or test. Allowed, and listed in the merge request so reviewers see it. |
| **Discrepancy** | A test the AI wrote to the requirement that fails because of the product, left as `test.fixme` with a `// QA-AGENT:` note, waiting for QA triage. |
| **Known defect** | A test QA marked `test.fail` with the bug link after triage. It runs every time; it goes red when the product is fixed. |

## Results: what a failing requirement test means

| Category | Meaning | Who decides |
| --- | --- | --- |
| ❓ **unclassified – needs triage** | It fails and nobody has said why yet. **The default.** | A person |
| 🐞 **product defect** | QA confirmed the product is wrong (known defect, bug link). | QA |
| 🌐 **environment** | The environment failed (network, certificates, gateway 502/503/504). No bug card is drafted. | qa-sentinel (from the error) |
| 🚧 **not built** | No code in the story's services does it (the plan says `not-found`; shown on bug cards as suspected). | QA confirms |
| ✅ **known defect now passes** | A `test.fail` test passed: the bug looks fixed. Remove `test.fail` and the `QA-BUG` line. | qa-sentinel (from the result), QA removes the marker |
| ⏳ **not deployed** | The change isn't running where the test ran (service `version` endpoint). | qa-sentinel (from the deployment check) |

qa-sentinel never reports a failure as a product defect on its own, and "the AI says it's implemented" is never a gate.

## Runs

| Term | Meaning |
| --- | --- |
| **VERIFIED / FAILED / BLOCKED / NOT_RUN** | qa-sentinel's own re-run of the changed tests, independent of what the AI reported. |
| **WAITING FOR DEPLOYMENT** | Tests ran against an environment that doesn't have the change yet; failures may only mean that. |
| **Flaky** | Failed once, passed on the automatic retry. Not a defect, not stable either. |
