import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

/**
 * The knowledge base: Markdown files the team writes in the test repo (default `kb/`), e.g. domain rules
 * ("a refund can never exceed the captured amount"), a glossary, and lessons from reviewing agent MRs.
 *
 * qa-sentinel gathers them into one file per run so every agent (planner, author, reviewer) reads the same rules.
 * In the oracle order they come after acceptance criteria and the API contract, before existing tests and code.
 * Agents can never write here (kb/ is outside the write policy); humans curate it through normal MRs.
 */
export interface Knowledge {
  files: string[];
  markdown: string;
  truncated: boolean;
}

function walk(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.md$/i.test(e.name) && e.name.toLowerCase() !== "readme.md") out.push(p);
  }
}

export function collectKnowledge(cwd: string, c: Config): Knowledge | undefined {
  const root = path.join(cwd, c.knowledge.dir);
  const abs: string[] = [];
  walk(root, abs);
  if (!abs.length) return undefined;
  const files = abs.map((f) => path.relative(cwd, f).split(path.sep).join("/"));
  let markdown = `# Team knowledge base (${c.knowledge.dir}/)\n\nDomain rules and review lessons written by the team. Cite a rule as evidence with source "domain-rule" and the file path.\n`;
  let truncated = false;
  for (const [i, f] of abs.entries()) {
    const section = `\n\n---\n## ${files[i]}\n\n${fs.readFileSync(f, "utf8").trim()}\n`;
    if (markdown.length + section.length > c.knowledge.maxChars) {
      truncated = true;
      markdown += `\n\n---\n_${abs.length - i} more file(s) not included (knowledge.maxChars = ${c.knowledge.maxChars}): ${files.slice(i).join(", ")}_\n`;
      break;
    }
    markdown += section;
  }
  return { files, markdown, truncated };
}

/** Write the run's knowledge file; returns its path relative to the test repo, or undefined when there is no kb. */
export function writeKnowledge(cwd: string, c: Config, runDir: string, runRel: string): string | undefined {
  const k = collectKnowledge(cwd, c);
  if (!k) return undefined;
  fs.writeFileSync(path.join(runDir, "knowledge.md"), k.markdown);
  return `${runRel}/knowledge.md`;
}

export const KB_README = `# Knowledge base for qa-sentinel

Markdown files here are read by every qa-sentinel agent (planning, writing tests, reviewing tests).
Write down what a new tester on the team would need to know and can't find in the stories or the API spec.

Good content:
- **Domain rules**: \`domain/payments.md\` – "A refund can never exceed the captured amount, across all partial refunds."
- **Glossary**: \`glossary.md\` – what "slot", "capture", "settlement" mean here.
- **Review lessons**: \`review-feedback.md\` – "Don't assert on generated ids; assert on the fields the AC names."

Rules:
- Keep each rule short and testable. Link the source (story, decision record) when there is one.
- Agents cite these rules as evidence ("domain-rule"). When a story is silent, a rule here can be the oracle.
- Agents never edit this folder; change it through a normal merge request.
- This README is not sent to the agents.
`;
