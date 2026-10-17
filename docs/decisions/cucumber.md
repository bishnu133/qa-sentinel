# Decision: Cucumber / BDD suites (D4)

**Status:** decided for v0.8 · **Build planned:** v0.9

## Question
Some teams write their tests as Cucumber `.feature` files with step definitions (often web tests). Should
qa-sentinel read them, and should its agents write them?

## What v0.8 does
- **Reads them.** Every Scenario and Scenario Outline in a `.feature` file under a test layer's folder is indexed like
  a test: tags on the Feature and Scenario lines (`@service:… @endpoint:… @page:… @story:SHOP-1 @ac:AC-2`) feed
  traceability, coverage, regression selection and the showcase readiness check. `@fixme` marks a known product
  discrepancy; `@wip`, `@skip`, `@ignore` and `@manual` mark a scenario that doesn't run.
- **Doesn't write them yet.** Generation writes code tests (Playwright, Mocha, …). A team with a Cucumber suite gets
  gap reports, regression selection and traceability from its features today; new tests come as code tests in a
  separate folder, or the team writes the scenarios from the gap report.

## Why not write them now
Writing good features is mostly about the team's existing step library: a new scenario should reuse steps, not add
near-duplicates. That needs (1) a step index (Given/When/Then patterns from the step definitions, with their
parameters), (2) agents that compose scenarios from it and add a step only when none fits, (3) running a subset of
scenarios (`cucumber-js` paths with `:line`, or tags) with a JUnit formatter for verification, and (4) guardrails
for step definition files. That is 5–8 days, and it is worth doing once a pilot team with a Cucumber suite can
review the output.

## Plan for v0.9
1. Step index from step definition files (cucumber-js, Playwright-BDD; Java/Python later), included in the agent
   context next to the conventions.
2. A `write-feature` skill: reuse steps; new steps go into the team's step folder, with page objects underneath.
3. Verification: `cucumber-js <feature>:<line>` (or `--tags`) with `--format junit:<file>`; `fixme` = a `@fixme` tag.
4. Config: `tests.web.framework: cucumber` (and api), with `stepsDir`.
