# qa-sentinel benchmark

Known developer changes with human-agreed expected QA decisions. The benchmark runs the **real** planning phase
(`gap-report`) and scores the validated test plan, so prompt, model or rule changes can be measured instead of guessed.

```bash
npm run bench                               # all scenarios once (~$0.70 with Claude Sonnet-class models)
npm run bench -- --only ac-conflict --runs 3   # three runs: also writes the consistency table (about $0.30)
npm run bench -- --summarise bench/results/<file>.json   # the consistency table of a saved file (free)
npm run bench -- --features                 # cases decided by qa-sentinel's own rules (free, no AI)
npm run bench -- --generate                 # runs `generate` too, on new-validation and test-data-collision (costs AI money)
npm run bench:mutate -- --scenario SHOP-101 # plant known defects in ShopLite and see which tests notice (free, no AI)
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
| Consistency (with `--runs N`, N at least 2) | per scenario: agreement on each expected change's decision, on the risk, the range of proposed scenarios, whether plan validity changed, checks that passed only in some runs |

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
| Test-data collision | `test-data-collision` (gap report: the plan asks for unique values and names the clash, judged by wording) and `npm run bench -- --generate` (the written tests use no fixed `reference`). The generation run needs the owner's Claude |
| Feature spans three microservices | `feature-three-services` in `bench/cases.ts`, run with `npm run bench -- --features` (no AI): a cross-service AC is held until every service is merged and the Jira card is ready, then planned |

## Risk and gap scenarios (PR 7)
| Scenario | What it measures |
| --- | --- |
| `db-migration` | qa-sentinel finds the migration from the file name and sets high risk in code (the check does not depend on what the AI says) |
| `dependency-major` | a major bump in `package.json` is found and sets high risk in code |
| `spec-drift` | the plan reports the code-vs-spec disagreement as a structured item with code evidence, and decides `review` |

The first two are mostly deterministic (the AI only has to produce a valid plan). Risk from history (A7) and access-control scenarios (A6) need a team history file and configured roles, so they are covered by unit tests, not by this benchmark.

## What each part measures, and what needs the owner
| Part | Measures | Cost | Run by |
| --- | --- | --- | --- |
| `npm run bench` (gap report) | the plan: gaps, decisions, risk, checks | AI, about $0.70 for all scenarios | owner |
| `--runs N` consistency table | how much N runs of the same scenario agree | AI, N times the above | owner (`--summarise` is free) |
| `--features` | the readiness rules across a three-service story | none | anyone, and unit tests |
| `--generate` | verification status, expected values present, review verdicts, collision check on written tests | AI; a rough estimate is $1-3 per scenario, not measured | owner (needs `npm install` and a free port) |
| `bench:mutate` | "N planted defects, M caught" by the tests | none | anyone with the ShopLite sandbox set up |
| `metrics` flaky rate, merge-to-MR hours | real runs' manifests and verification files | none | after real runs exist |
| `metrics --online` votes | 👍 and 👎 on gap report comments | none (GitLab calls) | owner with a GitLab token |

The unit tests cover the scoring and the summaries with fake engines and fixture files (test/mutate.test.ts, agreement.test.ts, benchCases.test.ts, generateBench.test.ts, trustMetrics.test.ts); no AI call is measured by them.

## Mutation check
`bench/mutations/<scenario>/` holds `reference.patch` (the correct implementation of the scenario, applied first), one `*.patch` per planted defect and `tests/` (a reference test suite laid over qa-tests). Each defect patch starts with `# mutation:`, `# service:`, `# describes:` and `# expect-killed-by:` (words of the test name that should fail; `none` means no test should notice). The runner copies the service, applies the reference and one defect, starts the local ShopLite environment, runs the API tests and counts a defect as caught when a test fails. It only means something when the tests pass on the correct code first, so that is checked and reported. The defects are few and hand-written: "6 of 7 caught" describes these tests against these defects, not a general mutation score. A defect that survives is either a gap in the tests or one no test could see (the shipped `slot-equal-to-now-accepted` is the second kind, and is expected to survive).

```bash
node sandbox/shoplite/local.mjs setup
npm run bench:mutate -- --scenario SHOP-101                       # the reference tests
npm run bench:mutate -- --scenario SHOP-101 --tests-ref <branch>  # tests an agent wrote (a branch of shoplite-local/qa-tests)
```
Add a scenario's defects by writing patches against the service as it is on `main` (plus the reference patch). Not built: generic mutation operators or Stryker-style tools on arbitrary services.

## Adding a scenario
Add an entry to `scenarios.ts`: the developer's change as file overrides of the base service, optional story and
test overrides, the expected changes (most specific first), and checks. Agree the expectations with a QA engineer
**before** running it; don't tune expectations to match output.
