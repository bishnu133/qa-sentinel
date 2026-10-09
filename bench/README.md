# qa-sentinel benchmark

Known developer changes with human-agreed expected QA decisions. The benchmark runs the **real** planning phase
(`gap-report`) and scores the validated test plan, so prompt, model or rule changes can be measured instead of guessed.

```bash
npm run bench                               # all scenarios once (~$0.70 with Claude Sonnet-class models)
npm run bench -- --only ac-conflict --runs 3
```

Results go to `bench/results/<timestamp>.{json,md}` and `bench/results/latest.md`. Each run's full evidence (plan, validated plan, contract diff, report, manifest) is kept in `bench/results/runs/` (gitignored).

## Metrics
| Metric | Meaning |
| --- | --- |
| Gap recall | expected changes that need work (update/create/review) which the plan flagged as needing work |
| Gap precision | plan gaps that correspond to an expected change needing work (unexpected gaps count against it) |
| Decision accuracy | expected changes whose matching plan changes all carry an acceptable decision (and oracle status) |
| Checks | scenario-specific checks: suspicious content flagged, requirement conflict reported, risk bounds, no fake "approved" oracle, stale test flagged |
| Plan valid / repairs / corrections | how often the agent's plan passed validation, needed the repair round, or was corrected by the safety rule |

Matching: a plan change belongs to the first expectation whose endpoint matches and whose **summary** contains one of its keywords.

## Coverage of the review's benchmark list (REVIEW-RESPONSE-1 §15)
| Review case | Where it is tested |
| --- | --- |
| New REST endpoint | `new-endpoint` |
| Response field renamed | `field-renamed` |
| New validation rule | `new-validation` |
| AC contradicts implementation | `ac-conflict` |
| Internal refactor | `internal-refactor` |
| Existing test passes for the wrong reason | `wrong-reason-pass` |
| Requirement missing | `missing-requirement` |
| Malicious instruction in MR | `prompt-injection` |
| QA environment unavailable | unit tests: verification reports `BLOCKED` (test/safety.test.ts) |
| Two simultaneous service changes | CI-level: one `resource_group` for all generation; not an analysis case |
| Test-data collision | generation-level; planned with the generation benchmark |
| Feature spans three microservices | not yet supported (feature manifests, v0.4); will be added as a failing case first |

## Adding a scenario
Add an entry to `scenarios.ts`: the developer's change as file overrides of the base service, optional story and
test overrides, the expected changes (most specific first), and checks. Agree the expectations with a QA engineer
**before** running it; don't tune expectations to match output.
