---
name: learn-from-review
description: Turn what QA engineers changed in agent-written tests before merging them into short, general rules for future tests (qa-sentinel's lessons JSON). Use when asked to learn from review edits.
---

# Learning from review edits in {{projectName}}

You get `review-edits.md`: for each agent merge request that a reviewer changed before merging, the diff from the agent's version (`-`) to what was merged (`+`). You may read the test repo for context (the tests, page/screen objects, the write-*-test skills) and the team's existing lessons file. You change nothing; you write one JSON file.

## What to look for
For each edit, ask: **what did the reviewer know that the agent didn't, and would it apply to the next test too?**
- An assertion strengthened or added (the agent checked only the status code; the reviewer also checked the message the AC names).
- A pattern replaced (a CSS selector → a role or test id; a sleep → a web-first assertion; data created through the UI → through the API).
- A convention applied (test naming, tags, where helpers live, which fixture to use).
- A wrong oracle corrected (the agent asserted what the code does; the reviewer asserted what the story says).

## What not to turn into a lesson
- One-off values (a different test email, a renamed variable), typos, formatting, or a fix specific to one feature. Put those in `skipped` with a short reason.
- Anything already covered by an existing lesson: instead set `updates` to that lesson's heading (exact text after `## `), so it is strengthened rather than repeated.

## Output
```json
{
  "schemaVersion": 1,
  "lessons": [
    {
      "lesson": "Assert the error message the acceptance criterion names, not only the status code.",
      "why": "Reviewers added message checks to 3 rejected-request tests; a 400 with the wrong reason would have passed.",
      "example": "expect(res.status()).toBe(400) → also expect((await res.json()).error).toBe('qty must be a positive integer')",
      "appliesTo": "api",
      "sources": ["a1b2c3d4", "e5f6a7b8"],
      "updates": null
    }
  ],
  "skipped": [{ "commit": "c9d0e1f2", "reason": "changed a test email only" }]
}
```
- `lesson`: one imperative sentence a test author can follow (max 240 characters), general enough for the next story.
- `appliesTo`: api · web · mobile · all. `sources`: the commits (first 8 characters, from the `##` headings) that show it.
- Every reviewed commit appears in some lesson's `sources` or in `skipped`.
- Fewer, stronger lessons beat many weak ones: at most 5 per run.
