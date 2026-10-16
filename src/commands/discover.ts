import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ConfigSchema, configPath, loadConfig } from "../config.js";
import { type Classified, type DependencySuggestion, classifyProject, dependencyEvidenceFiles, suggestDependencies } from "../discover.js";
import { type GitLabContext, gitlabContext, groupProjects, projectFiles, rawFile } from "../scm/gitlab.js";
import { log } from "../log.js";

export interface DiscoverOptions {
  cwd: string;
  group: string;
  subgroups?: boolean;
  out?: string;
  /** Add the discovered services that aren't configured yet to qa-sentinel.config.yaml. */
  apply?: boolean;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}

export interface DiscoveredService extends Classified {
  name: string;
  gitlabProject: string;
  defaultBranch?: string;
  dependsOn: DependencySuggestion[];
  configured?: string;
  error?: string;
}

const slug = (p: any) => String(p.path ?? p.name).toLowerCase();

async function inspect(ctx: GitLabContext, p: any): Promise<{ service: DiscoveredService; texts: { file: string; text: string }[] }> {
  const base = { name: slug(p), gitlabProject: String(p.path_with_namespace), defaultBranch: p.default_branch, dependsOn: [] as DependencySuggestion[] };
  if (!p.default_branch) return { service: { ...base, kind: "unknown", specs: [], why: "empty repository" }, texts: [] };
  const files = await projectFiles(ctx, p.id, p.default_branch);
  const read = async (f: string) => {
    try {
      const t = await rawFile(ctx, p.id, f, p.default_branch);
      return t && t.length < 200_000 ? t : undefined;
    } catch {
      return undefined;
    }
  };
  const pkgText = files.includes("package.json") ? await read("package.json") : undefined;
  let pkg: any;
  try {
    pkg = pkgText ? JSON.parse(pkgText) : undefined;
  } catch {
    pkg = undefined;
  }
  const build: Record<string, string> = {};
  for (const f of files.filter((x) => /^(pom\.xml|build\.gradle(\.kts)?|app\/build\.gradle(\.kts)?)$/.test(x)).slice(0, 3)) {
    const t = await read(f);
    if (t) build[f] = t;
  }
  const texts: { file: string; text: string }[] = [];
  for (const f of dependencyEvidenceFiles(files)) {
    const t = await read(f);
    if (t) texts.push({ file: f, text: t });
  }
  return { service: { ...base, ...classifyProject(files, pkg, build) }, texts };
}

/** `qa-sentinel discover --gitlab-group`: draft service entries (kind, spec, dependencies with evidence) for QA to accept. */
export async function discoverCommand(o: DiscoverOptions): Promise<number> {
  const cwd = path.resolve(o.cwd);
  const c = loadConfig(cwd);
  const ctx = gitlabContext(c.ci.gitlabUrl, o.env ?? process.env);
  if (!ctx) {
    log.fail("set QA_SENTINEL_GITLAB_TOKEN (read_api is enough) to read the group");
    return 2;
  }
  const all = await groupProjects(ctx, o.group, o.subgroups !== false);
  const testRepo = c.ci.testRepoProject?.toLowerCase();
  const projects = all.filter((p) => String(p.path_with_namespace).toLowerCase() !== testRepo && String(p.id) !== testRepo).slice(0, o.limit ?? 200);
  log.step(`${o.group}: ${projects.length} project(s)${all.length > projects.length ? ` (of ${all.length})` : ""}`);

  const found: DiscoveredService[] = [];
  const evidence = new Map<DiscoveredService, { file: string; text: string }[]>();
  for (const p of projects) {
    try {
      const r = await inspect(ctx, p);
      found.push(r.service);
      evidence.set(r.service, r.texts);
      log.dim(`  ${r.service.name.padEnd(28)} ${r.service.kind}${r.service.specs[0] ? ` · ${r.service.specs[0]}` : ""}`);
    } catch (e) {
      found.push({ name: slug(p), gitlabProject: String(p.path_with_namespace), kind: "unknown", specs: [], why: "could not be read", dependsOn: [], error: (e as Error).message.split("\n")[0] });
    }
  }
  // Same project name in two subgroups (team-a/orders, team-b/orders): prefix with the parent group to keep names unique.
  const counts = new Map<string, number>();
  for (const s of found) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  for (const s of found) {
    const other = c.workspace.services.find((x) => x.name === s.name && x.gitlabProject && x.gitlabProject.toLowerCase() !== s.gitlabProject.toLowerCase());
    if ((counts.get(s.name) ?? 0) > 1 || other) s.name = s.gitlabProject.split("/").slice(-2).join("-").toLowerCase();
  }
  const services = found.filter((s) => s.kind === "api" || s.kind === "web" || s.kind === "mobile");
  const deps = suggestDependencies(services.map((s) => ({ name: s.name, match: s.gitlabProject.split("/").pop()!.toLowerCase(), texts: evidence.get(s) ?? [] })));
  for (const s of services) s.dependsOn = deps.filter((d) => d.from === s.name);
  for (const s of services) {
    const match = c.workspace.services.find((x) => x.gitlabProject?.toLowerCase() === s.gitlabProject.toLowerCase() || (!x.gitlabProject && x.name === s.name));
    if (match) s.configured = match.name;
  }

  const draft = draftYaml(services);
  const out = path.resolve(cwd, o.out ?? "qa-services.draft.yaml");
  fs.writeFileSync(out, draft);
  fs.writeFileSync(out.replace(/\.ya?ml$/, "") + ".md", discoverMarkdown(o.group, found, services));
  log.ok(`${services.length} service(s) (${services.filter((s) => s.configured).length} already configured), ${deps.length} suggested dependenc${deps.length === 1 ? "y" : "ies"}`);
  log.dim(`draft: ${path.relative(cwd, out)} · evidence: ${path.relative(cwd, out.replace(/\.ya?ml$/, "") + ".md")}`);

  if (o.apply) {
    const file = configPath(cwd);
    const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
    const fresh = services.filter((s) => !s.configured);
    for (const s of fresh) doc.addIn(["workspace", "services"], entryOf(s));
    // Validate before writing: a failure must leave the team's config untouched.
    const check = ConfigSchema.safeParse(doc.toJS());
    if (!check.success) {
      log.fail(`not applied, the result would be invalid: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      return 1;
    }
    fs.writeFileSync(file, doc.toString());
    log.ok(`added ${fresh.length} service(s) to qa-sentinel.config.yaml; review them with git diff (paths assume clones next to the test repo)`);
  } else log.info("Review the draft, delete what isn't right, then copy the entries into workspace.services (or rerun with --apply).");
  return 0;
}

function entryOf(s: DiscoveredService): Record<string, unknown> {
  return {
    name: s.name,
    path: `../${s.name}`,
    gitlabProject: s.gitlabProject,
    ...(s.kind !== "api" ? { kind: s.kind } : {}),
    ...(s.specs[0] ? { openapi: s.specs[0] } : {}),
    dependsOn: s.dependsOn.map((d) => d.to),
  };
}

export function draftYaml(services: DiscoveredService[]): string {
  const doc = new YAML.Document({ services: services.map(entryOf) });
  const seq = doc.get("services") as YAML.YAMLSeq;
  services.forEach((s, i) => {
    const item = seq.items[i] as YAML.YAMLMap;
    const notes = [
      `${s.kind}: ${s.why}${s.configured ? ` · already configured as "${s.configured}"` : ""}`,
      ...(s.specs.length > 1 ? [`other spec files: ${s.specs.slice(1, 4).join(", ")}`] : []),
      ...(s.generator && !s.specs.length ? [`spec generated at build time by ${s.generator}: set openapi (output file) and openapiCommand`] : []),
      ...(s.generator && s.specs.length ? [`uses ${s.generator}: if ${s.specs[0]} isn't committed output, set openapiCommand`] : []),
      ...(s.kind === "web" ? ["add routes: the pages this front end serves (e.g. /orders/new)"] : []),
      ...s.dependsOn.map((d) => `depends on ${d.to}? (${d.evidence})`),
    ];
    item.commentBefore = notes.map((n) => ` ${n}`).join("\n");
  });
  return `# qa-sentinel discover: suggestions, for QA to accept. Copy the entries you agree with into workspace.services.\n${doc.toString({ lineWidth: 120 })}`;
}

export function discoverMarkdown(group: string, all: DiscoveredService[], services: DiscoveredService[]): string {
  const out = [`# Services in ${group}`, "", "| Project | Kind | OpenAPI spec | Calls (suggested) | Configured |", "| --- | --- | --- | --- | --- |"];
  for (const s of services)
    out.push(
      `| ${s.gitlabProject} | ${s.kind} | ${s.specs[0] ?? (s.generator ? `generated (${s.generator.split(" ")[0]})` : "–")} | ${s.dependsOn.map((d) => `${d.to} (\`${d.evidence}\`)`).join("<br>") || "–"} | ${s.configured ?? "no"} |`,
    );
  const rest = all.filter((s) => !services.includes(s));
  if (rest.length) {
    out.push("", "**Not treated as services** (add them by hand if they are):", "");
    for (const s of rest) out.push(`- ${s.gitlabProject}: ${s.kind}, ${s.error ?? s.why}`);
  }
  out.push("", "Dependencies are suggested from config files (env examples, docker-compose, application/values files) that name another service. Check each one: a name in a comment or an unused variable is still a match.");
  return out.join("\n") + "\n";
}
