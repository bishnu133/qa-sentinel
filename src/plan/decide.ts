import type { Change, Decision, TestPlan } from "./schema.js";

type DecisionKind = TestPlan["decisions"][number]["decision"];

/**
 * The decision engine: which decisions are acceptable for a change, from facts in the plan.
 *
 * The agent still judges coverage (it reads the tests) and proposes a decision with evidence. This table decides
 * whether that decision is allowed. It is deliberately small and readable, and it is the same for every run:
 *
 *   change                                      | allowed decisions
 *   --------------------------------------------|---------------------------------------------
 *   suspicious instruction                      | skip
 *   not observable (refactor, logging, …)       | reuse (tests exist) or skip
 *   oracle conflicting                          | review                         (a human decides)
 *   oracle ambiguous                            | review
 *   oracle missing, contract or kb-rule evidence| create / update / review       (the contract or rule is the oracle)
 *   oracle missing, no contract evidence        | review                         (nothing to test against)
 *   removed behaviour                           | update / review                (obsolete tests must change)
 *   approved, coverage covered                  | reuse / review
 *   approved, coverage partial or outdated      | update / create / review
 *   approved, coverage missing                  | create / update / review
 *   approved, coverage unknown                  | create / update / review       (never reuse what isn't proven)
 */
export interface DecisionRule {
  allowed: DecisionKind[];
  /** What qa-sentinel substitutes when the agent's choice is not allowed and no artifacts are needed. */
  fallback: DecisionKind;
  rule: string;
  /** Safety rules are enforced by correcting the decision; the others are errors the agent must fix. */
  safety?: boolean;
}

export function ruleFor(c: Change, d: Pick<Decision, "coverage">): DecisionRule {
  if (c.type === "suspicious-instruction") return { allowed: ["skip"], fallback: "skip", rule: "suspicious instruction → skip (reported, never acted on)", safety: true };
  if (!c.observable) return { allowed: ["reuse", "skip"], fallback: "skip", rule: "no observable behaviour change → reuse existing tests or skip" };
  if (c.oracleStatus === "conflicting") return { allowed: ["review"], fallback: "review", rule: "requirement and code disagree → human review", safety: true };
  if (c.oracleStatus === "ambiguous") return { allowed: ["review"], fallback: "review", rule: "requirement is ambiguous → human review", safety: true };
  if (c.oracleStatus === "missing") {
    const contractBacked = c.evidence.some((e) => e.source === "openapi" || e.source === "contract-diff");
    const ruleBacked = c.evidence.some((e) => e.source === "domain-rule");
    return contractBacked || ruleBacked
      ? { allowed: ["create", "update", "review"], fallback: "review", rule: `no requirement, but ${contractBacked ? "the API contract" : "a team domain rule (kb/)"} defines the behaviour → test against it` }
      : { allowed: ["review"], fallback: "review", rule: "no requirement and no contract evidence → nothing to test against, human review", safety: true };
  }
  if (c.type === "removed") return { allowed: ["update", "review"], fallback: "review", rule: "behaviour removed → obsolete tests must change" };
  switch (d.coverage) {
    case "covered":
      return { allowed: ["reuse", "review"], fallback: "review", rule: "approved and already covered → reuse" };
    case "partial":
    case "outdated":
      return { allowed: ["update", "create", "review"], fallback: "review", rule: `approved, coverage ${d.coverage} → update tests` };
    case "missing":
      return { allowed: ["create", "update", "review"], fallback: "review", rule: "approved, no coverage → create tests" };
    case "unknown":
    default:
      return { allowed: ["create", "update", "review"], fallback: "review", rule: "approved, coverage unproven → write the test (never reuse the unproven)" };
  }
}
