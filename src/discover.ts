/**
 * Discovering a team's services from a GitLab group: which projects are services, where their OpenAPI specs are,
 * and which services call which (from config files: env examples, docker-compose, Spring/Helm config). Pure
 * functions here; the command fetches. Everything is a suggestion with its evidence, for QA to accept.
 */

export type DiscoveredKind = "api" | "web" | "mobile" | "library" | "unknown";

export interface Classified {
  kind: DiscoveredKind;
  specs: string[];
  /** The project generates its spec at build time (a dependency says so): openapiCommand is needed. */
  generator?: string;
  why: string;
}

const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|target|\.git|test|tests|__tests__|spec|e2e|fixtures?|examples?|docs\/examples)\//i;
const SKIP_SPEC_DIR = /(^|\/)(node_modules|vendor|dist|build|target|\.git|test|tests|__tests__|e2e|fixtures?|examples?)\//i;
const SPEC_FILE = /(^|\/)([\w.-]*(openapi|swagger)[\w.-]*|api-?docs?|api)\.(ya?ml|json)$/i;

export function findSpecs(files: string[]): string[] {
  return files
    .filter((f) => SPEC_FILE.test(f) && !SKIP_SPEC_DIR.test(f) && !/package(-lock)?\.json$|tsconfig/i.test(f))
    .sort((a, b) => a.split("/").length - b.split("/").length || Number(!/openapi/i.test(a)) - Number(!/openapi/i.test(b)) || a.localeCompare(b));
}

const WEB_DEPS = ["react", "react-dom", "vue", "@angular/core", "next", "nuxt", "svelte", "@sveltejs/kit", "solid-js", "preact", "gatsby", "@remix-run/react"];
const API_DEPS = ["express", "fastify", "@nestjs/core", "koa", "@hapi/hapi", "hono", "restify", "loopback", "@loopback/core", "apollo-server", "@apollo/server", "tsoa"];
const MOBILE_DEPS = ["react-native", "expo", "@capacitor/core", "@ionic/angular", "nativescript"];
const GENERATORS: [string, string][] = [
  ["tsoa", "tsoa (e.g. `npx tsoa spec`)"],
  ["@nestjs/swagger", "@nestjs/swagger (a script that writes the document)"],
  ["swagger-jsdoc", "swagger-jsdoc"],
  ["express-openapi", "express-openapi"],
  ["fastify-swagger", "fastify-swagger"],
  ["@fastify/swagger", "@fastify/swagger"],
];

export function classifyProject(files: string[], pkg: any, buildFiles: Record<string, string> = {}): Classified {
  const specs = findSpecs(files);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (d: string) => d in deps;
  const gradle = Object.entries(buildFiles).filter(([f]) => /(^|\/)build\.gradle(\.kts)?$/.test(f)).map(([, t]) => t).join("\n");
  const pom = buildFiles["pom.xml"] ?? "";
  const generator = GENERATORS.find(([d]) => has(d))?.[1] ?? (/springdoc-openapi/.test(gradle + pom) ? "springdoc (e.g. `./mvnw verify` / the springdoc maven or gradle plugin)" : /springfox/.test(gradle + pom) ? "springfox" : undefined);

  if (MOBILE_DEPS.some(has)) return { kind: "mobile", specs, generator, why: `package.json: ${MOBILE_DEPS.filter(has).join(", ")}` };
  if (/com\.android\.application/.test(gradle) || files.some((f) => /AndroidManifest\.xml$/.test(f) && !SKIP_DIR.test(f))) return { kind: "mobile", specs, generator, why: "Android app" };
  if (files.some((f) => /\.xcodeproj\//.test(f))) return { kind: "mobile", specs, generator, why: "iOS app (Xcode project)" };
  if (API_DEPS.some(has)) return { kind: "api", specs, generator, why: `package.json: ${API_DEPS.filter(has).join(", ")}` };
  if (/spring-boot|org\.springframework|micronaut|quarkus|ktor/.test(gradle + pom)) return { kind: "api", specs, generator, why: "JVM web framework in the build file" };
  if (files.some((f) => /(^|\/)(manage\.py|main\.go|go\.mod|Gemfile|composer\.json|requirements\.txt|pyproject\.toml)$/.test(f)) && specs.length) return { kind: "api", specs, generator, why: `OpenAPI spec ${specs[0]}` };
  if (WEB_DEPS.some(has)) return { kind: "web", specs, generator, why: `package.json: ${WEB_DEPS.filter(has).join(", ")}` };
  if (specs.length) return { kind: "api", specs, generator, why: `OpenAPI spec ${specs[0]}` };
  if (pkg && (pkg.main || pkg.exports || pkg.types) && !pkg.scripts?.start) return { kind: "library", specs, generator, why: "package with main/exports and no start script" };
  return { kind: "unknown", specs, generator, why: "no framework or spec recognised" };
}

/** Files that usually name the services a project calls (URLs, hosts, env keys). Small and few, by design. */
export function dependencyEvidenceFiles(files: string[], max = 12): string[] {
  const score = (f: string) =>
    /(^|\/)\.env\.(example|sample|template|dist|defaults)$/.test(f)
      ? 0
      : /(^|\/)docker-compose[\w.-]*\.ya?ml$/.test(f)
        ? 1
        : /(^|\/)application[\w.-]*\.(ya?ml|properties)$/.test(f)
          ? 2
          : /(^|\/)values[\w.-]*\.ya?ml$/.test(f)
            ? 3
            : /(^|\/)(config|configs|conf|settings)(\/[\w.-]+)?\.(json|ya?ml|ts|js|toml)$/.test(f) || /(^|\/)(config|configs|conf)\/[\w.-]+\.(json|ya?ml|ts|js|toml)$/.test(f)
              ? 4
              : -1;
  return files
    .filter((f) => !SKIP_DIR.test(f) && score(f) >= 0)
    .sort((a, b) => score(a) - score(b) || a.split("/").length - b.split("/").length)
    .slice(0, max);
}

export interface ProjectEvidence {
  name: string;
  /** How other projects' config names it, when that differs from `name` (the repository name). */
  match?: string;
  texts: { file: string; text: string }[];
}

export interface DependencySuggestion {
  from: string;
  to: string;
  evidence: string; // file:line
}

const SUFFIX = /[-_](service|svc|api|server|backend|app)$/i;

/** How another service may be named in config: its slug in kebab, snake, SCREAMING_SNAKE and camel case. */
export function nameVariants(slug: string): RegExp[] {
  const words = slug.toLowerCase().split(/[-_.\s]+/).filter(Boolean);
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const kebab = words.join("-");
  // Separators count as boundaries ("VITE_PAYMENTS_SERVICE_URL", "payments-service:3000"); letters and digits don't.
  const out = [kebab, words.join("_")].map((v) => new RegExp(`(?<![A-Za-z0-9])${esc(v)}(?![A-Za-z0-9])`, "i"));
  if (words.length > 1) {
    // camelCase may continue with a capital ("paymentsServiceUrl").
    const camel = words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
    out.push(new RegExp(`(?<![A-Za-z0-9])${esc(camel)}(?![a-z0-9])`));
  }
  // The bare name without "-service" ("orders" for orders-service) only in a URL host or next to a service-ish word.
  const short = kebab.replace(SUFFIX, "");
  if (short !== kebab && short.length >= 4) {
    const s = esc(short).replace(/-/g, "[-_]");
    out.push(new RegExp(`https?://${s}(?![A-Za-z0-9])|(?<![A-Za-z0-9])${s}[-_](?:service|svc|api|url|host|base[-_]?url|endpoint)(?![A-Za-z0-9])`, "i"));
  }
  return out;
}

export function suggestDependencies(projects: ProjectEvidence[]): DependencySuggestion[] {
  const out: DependencySuggestion[] = [];
  for (const a of projects) {
    for (const b of projects) {
      if (a.name === b.name) continue;
      const res = nameVariants(b.match ?? b.name);
      let found: string | undefined;
      for (const t of a.texts) {
        const lines = t.text.split(/\r?\n/);
        const i = lines.findIndex((l) => !/^\s*(#|\/\/)/.test(l) && res.some((re) => re.test(l)));
        if (i >= 0) {
          found = `${t.file}:${i + 1}`;
          break;
        }
      }
      if (found) out.push({ from: a.name, to: b.name, evidence: found });
    }
  }
  return out;
}
