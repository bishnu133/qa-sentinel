// Shared helpers for the demo kit scripts. No dependencies beyond Node 20.
// Rules kept here: tokens are never printed, nothing is written without an explicit flag, and every script works
// only on the projects and cards listed in the state file (.demo-state.json).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_DIR = path.resolve(HERE, "..");
export const TEMPLATE_DIR = path.join(DEMO_DIR, "shoplite-demo");
export const DEFAULT_STATE = path.join(DEMO_DIR, ".demo-state.json");
export const DEFAULT_CONFIG = path.join(DEMO_DIR, "demo.config.json");

/** Everything qa-sentinel writes carries a marker that starts with this text. */
export const MARKER = "qa-sentinel:";
/** qa-sentinel's Jira issue properties (written by the tool itself). */
export const JIRA_PROPERTIES = ["qa-sentinel.record", "qa-sentinel.showcase", "qa-sentinel.bugs"];

/** An error with a plain message. The command line prints it and exits with 1. */
export class DemoError extends Error {}
export const fail = (msg) => {
  throw new DemoError(msg);
};

/** --flag, --flag value and --flag=value. Anything else is a positional argument. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

/** --yes must be given bare. "--yes false" or "--yes=no" is an error, not a yes. */
export function wantsWrite(args) {
  if (args.yes === undefined) return false;
  if (args.yes !== true) fail('--yes takes no value. Use it as plain "--yes", or leave it out for a dry run.');
  return true;
}

/** The test-project flag must carry the project key: --i-know-this-is-a-test-project <KEY>. */
export function needTestFlag(args, project, what) {
  const flag = args["i-know-this-is-a-test-project"];
  if (flag !== project) fail(`Refusing to ${what}. Add --i-know-this-is-a-test-project ${project}  (the key of your TEST project, written out, so a copy and paste cannot hit another project).`);
}

/** The environment a child process like npm gets: no tokens. */
const CLEAN_ENV = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "npm_config_registry", "QA_SENTINEL_BIN", "SystemRoot"];
export const cleanEnv = (env = process.env) => Object.fromEntries(CLEAN_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));

/** Is this Jira issue one the demo made? Key shape, label and summary must all fit. */
export function demoCardProblem({ key, project, issue, summary }) {
  if (!new RegExp(`^${project}-\\d+$`).test(key)) return `the key does not look like ${project}-<number>`;
  if (summary === undefined) return "it is not a card of cards.json";
  if (!(issue?.fields?.labels ?? []).includes("qa-sentinel-demo")) return 'it has no "qa-sentinel-demo" label';
  if (issue?.fields?.summary !== summary) return "its summary is not the one in cards.json";
  return undefined;
}

/** Hide secrets in any text before it is printed. */
export function redact(text, secrets = []) {
  let s = String(text);
  for (const x of secrets) if (x && String(x).length >= 4) s = s.split(String(x)).join("***");
  return s.replace(/(glpat-|ATATT)[A-Za-z0-9_\-=.]+/g, "$1***");
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

export function loadConfig(file = DEFAULT_CONFIG) {
  if (!fs.existsSync(file)) fail(`No config file at ${file}. Copy demo/demo.config.example.json to demo/demo.config.json and fill it in.`);
  const c = readJson(file);
  for (const k of ["gitlabUrl", "testsProject"]) if (!c[k] || /<.*>|your-/i.test(String(c[k]))) fail(`demo.config.json: "${k}" is missing or still a placeholder.`);
  if (!Array.isArray(c.services) || !c.services.length) fail('demo.config.json: "services" needs at least the orders service.');
  for (const x of c.services) {
    if (!x.name || !x.project || /<.*>|your-/i.test(`${x.name}${x.project}`)) fail(`demo.config.json: services[].name and services[].project must be filled in (no <placeholders>): ${JSON.stringify(x)}`);
    if (!PROJECT_RE.test(x.project)) fail(`demo.config.json: "${x.project}" is not a GitLab project path like group/name.`);
  }
  if (!PROJECT_RE.test(c.testsProject)) fail(`demo.config.json: "${c.testsProject}" is not a GitLab project path like group/name.`);
  for (const x of c.services) x.template ||= x.name === "payments-service" ? "service-payments" : "service-orders";
  c.defaultBranch ||= "main";
  c.releaseBranch ||= "release/demo";
  return c;
}

const PROJECT_SHAPE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;
/** group/name, where no part is only dots ("." and ".." would walk out of the path). */
export const PROJECT_RE = { test: (v) => PROJECT_SHAPE.test(v) && v.split("/").every((part) => !/^\.+$/.test(part)) };
export const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9._\/-]+$/;

/** The state file is a plain file on disk. Every value that goes into a URL is checked here, so a damaged or edited file cannot point a script elsewhere. */
export function validateState(s, file = "the state file") {
  const bad = (what) => fail(`${file} is not valid (${what}). Nothing was changed. Fix or delete the file on purpose.`);
  const projects = [...(s.gitlab?.projects ?? []), ...(s.gitlab?.testsProject ? [s.gitlab.testsProject] : [])];
  for (const p of projects) if (typeof p !== "string" || !PROJECT_RE.test(p)) bad(`project "${p}"`);
  for (const b of [s.gitlab?.defaultBranch, s.gitlab?.releaseBranch].filter((x) => x !== undefined)) if (typeof b !== "string" || !BRANCH_RE.test(b)) bad(`branch "${b}"`);
  for (const [sha] of Object.entries(s.gitlab?.baselines ?? {}).map(([k, v]) => [v, k])) if (typeof sha !== "string" || !SHA_RE.test(sha)) bad("a baseline commit");
  for (const [id, c] of Object.entries(s.cards ?? {})) if (typeof c?.key !== "string" || !KEY_RE.test(c.key)) bad(`card ${id} key "${c?.key}"`);
  for (const m of s.mrs ?? []) {
    if (!Number.isInteger(m.iid) || m.iid < 1) bad(`merge request number "${m.iid}"`);
    if (typeof m.project !== "string" || !PROJECT_RE.test(m.project)) bad(`merge request project "${m.project}"`);
    for (const b of [m.branch, m.target]) if (b !== undefined && (typeof b !== "string" || !BRANCH_RE.test(b))) bad(`branch "${b}"`);
    if (m.mergeSha !== undefined && !SHA_RE.test(String(m.mergeSha))) bad("a merge commit");
  }
  for (const m of s.merges ?? []) {
    if (typeof m.sha !== "string" || !SHA_RE.test(m.sha)) bad(`commit "${m.sha}"`);
    if (typeof m.project !== "string" || !PROJECT_RE.test(m.project)) bad(`project "${m.project}"`);
    if (typeof m.branch !== "string" || !BRANCH_RE.test(m.branch)) bad(`branch "${m.branch}"`);
  }
  for (const b of s.branches ?? []) {
    if (typeof b.project !== "string" || !PROJECT_RE.test(b.project)) bad(`project "${b.project}"`);
    if (typeof b.branch !== "string" || !BRANCH_RE.test(b.branch)) bad(`branch "${b.branch}"`);
  }
  for (const b of s.raisedBugs ?? []) if (typeof b.key !== "string" || !KEY_RE.test(b.key) || typeof b.story !== "string" || !KEY_RE.test(b.story)) bad("a remembered bug key");
  if (s.jira?.project !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(String(s.jira.project))) bad(`Jira project "${s.jira.project}"`);
  return s;
}

export function loadState(file = DEFAULT_STATE) {
  if (!fs.existsSync(file)) return { version: 1, cards: {}, mrs: [], merges: [], branches: [], gitlab: {}, jira: {} };
  const s = readJson(file);
  return validateState({ cards: {}, mrs: [], merges: [], branches: [], gitlab: {}, jira: {}, ...s, version: 1 }, file);
}
export const saveState = (file, state) => writeJson(file, state);

// ---------------------------------------------------------------------------------------------
// HTTP

export class HttpError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request(base, method, route, { headers, body, secrets, label, raw }) {
  let res;
  try {
    res = await fetch(`${base}${route}`, { method, headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    const c = e.cause ?? {};
    const why = [c.code, c.message].filter(Boolean).join(": ") || e.message;
    throw new HttpError(redact(`${label} ${method} ${route} failed: ${why}`, secrets), 0);
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(redact(`${label} ${method} ${route}: ${res.status} ${text.slice(0, 200)}`, secrets), res.status, text);
  if (raw) return { data: text, headers: res.headers };
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(redact(`${label} ${method} ${route}: the answer is not JSON (a login page or proxy in front?)`, secrets), res.status, text);
  }
  return { data, headers: res.headers };
}

export const enc = encodeURIComponent;

/** GitLab REST client. The token is read from the environment and never printed. */
export function makeGitLab(url, env = process.env) {
  const token = env.GITLAB_TOKEN ?? env.QA_SENTINEL_GITLAB_TOKEN;
  if (!token) fail("Set GITLAB_TOKEN (a personal access token with the api scope).");
  const base = `${String(url).replace(/\/+$/, "")}/api/v4`;
  const opt = { headers: { "PRIVATE-TOKEN": token }, secrets: [token], label: "GitLab" };
  const api = async (method, route, body) => (await request(base, method, route, { ...opt, body })).data;
  const rawFile = async (project, file, ref) => (await request(base, "GET", `/projects/${enc(project)}/repository/files/${enc(file)}/raw?ref=${enc(ref)}`, { ...opt, raw: true })).data;
  /** All pages of a list route. */
  const getAll = async (route, max = 20) => {
    const out = [];
    for (let page = 1; page <= max; page++) {
      const sep = route.includes("?") ? "&" : "?";
      const part = await api("GET", `${route}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(part)) return part;
      out.push(...part);
      if (part.length < 100) break;
    }
    return out;
  };
  return { api, rawFile, getAll, url: String(url).replace(/\/+$/, "") };
}

/** Jira REST client (API v2). Cloud: JIRA_EMAIL + JIRA_API_TOKEN. Server/Data Center: JIRA_PAT. Same rule as requirements.jira.auth. */
export function jiraAuthHeader(mode = "auto", env = process.env) {
  const cloud = () => (env.JIRA_EMAIL && env.JIRA_API_TOKEN ? `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64")}` : undefined);
  const pat = () => (env.JIRA_PAT ? `Bearer ${env.JIRA_PAT}` : undefined);
  if (mode === "cloud") return cloud();
  if (mode === "pat") return pat();
  return env.JIRA_EMAIL ? (cloud() ?? pat()) : (pat() ?? cloud());
}

export function makeJira(baseUrl, authMode = "auto", env = process.env) {
  const auth = jiraAuthHeader(authMode, env);
  if (!auth) fail("Jira login missing. Cloud: set JIRA_EMAIL and JIRA_API_TOKEN. Server/Data Center: set JIRA_PAT (and jira.auth in demo.config.json to match requirements.jira.auth).");
  const base = String(baseUrl).replace(/\/+$/, "");
  const opt = { headers: { Authorization: auth }, secrets: [env.JIRA_API_TOKEN, env.JIRA_PAT], label: "Jira" };
  const api = async (method, route, body) => (await request(base, method, route, { ...opt, body })).data;
  /** Who the login belongs to. Needed before any comment is deleted. */
  const me = async () => {
    const u = await api("GET", "/rest/api/2/myself");
    if (!u || !(u.accountId || u.name || u.key)) fail("Jira did not say who the login belongs to (GET /rest/api/2/myself), so no comment will be deleted.");
    return u;
  };
  return { api, me, baseUrl: base };
}

export function sameUser(author, me) {
  if (!author || !me) return false;
  for (const f of ["accountId", "key", "name"]) if (author[f] && me[f]) return author[f] === me[f];
  return false;
}

// ---------------------------------------------------------------------------------------------
// Change files (the developer's change for a card)

/** Apply [from, to] pairs. Throws when a search text is missing, so a change never silently does nothing. */
export function applyEdits(content, pairs, label = "file") {
  let s = content;
  for (const [from, to] of pairs) {
    if (!s.includes(from)) fail(`The change does not fit ${label}: this text was not found: "${from.slice(0, 70)}". Is the earlier card merged (or already reset)?`);
    s = s.replace(from, () => to);
  }
  return s;
}

export function loadChange(name, dir = path.join(TEMPLATE_DIR, "changes")) {
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) fail(`No change file ${file}`);
  return readJson(file);
}

export function loadCards(file = path.join(DEMO_DIR, "jira", "cards.json")) {
  return readJson(file);
}

/** Story markdown (numbered acceptance criteria) to Jira wiki markup. */
export const toWiki = (md) =>
  md
    .split("\n")
    .map((l) => l.replace(/^##\s+(.*)$/, "h2. $1").replace(/^\d+\.\s+/, "# ").replace(/^-\s+/, "* "))
    .join("\n");

export const say = (...a) => console.log(...a);

/** Run a main() and turn DemoError into a clean message and exit code 1. */
export async function runCli(main, argv = process.argv.slice(2)) {
  try {
    const code = await main(parseArgs(argv));
    process.exitCode = typeof code === "number" ? code : 0;
  } catch (e) {
    console.error(`\nSTOP: ${redact(e.message, [process.env.GITLAB_TOKEN, process.env.QA_SENTINEL_GITLAB_TOKEN, process.env.JIRA_API_TOKEN, process.env.JIRA_PAT])}`);
    process.exitCode = 1;
  }
}

/** True when this file was started from the command line (not imported by a test). */
export const isMain = (metaUrl) => process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
