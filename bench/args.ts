/**
 * Command-line parsing for the bench scripts. The rule: anything unclear is a usage error (exit 2) BEFORE anything
 * that costs money can start. A flag that needs a value but has none, a bad number, an unknown flag (a typo such as
 * `--summarize`) or an unknown scenario never falls through to the paid benchmark.
 */
export interface FlagSpec {
  /** Flags that need a value, and what kind. */
  values: Record<string, "string" | "positive-int" | "list">;
  /** Flags without a value. */
  switches: string[];
}

export type Parsed = { ok: true; values: Record<string, string>; lists: Record<string, string[]>; ints: Record<string, number>; switches: Set<string> } | { ok: false; error: string };

export function parseFlags(argv: string[], spec: FlagSpec): Parsed {
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const ints: Record<string, number> = {};
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) return { ok: false, error: `unexpected argument "${a}"` };
    const name = a.slice(2);
    if (spec.switches.includes(name)) {
      switches.add(name);
      continue;
    }
    const kind = spec.values[name];
    if (!kind) return { ok: false, error: `unknown option --${name}` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--") || !v.trim()) return { ok: false, error: `--${name} needs a value` };
    i++;
    if (kind === "positive-int") {
      if (!/^[1-9]\d{0,3}$/.test(v)) return { ok: false, error: `--${name} must be a whole number of at least 1 (got "${v}")` };
      ints[name] = Number(v);
    } else if (kind === "list") {
      const items = v.split(",").map((x) => x.trim());
      if (items.some((x) => !x)) return { ok: false, error: `--${name} has an empty item (got "${v}")` };
      lists[name] = items;
    } else values[name] = v;
  }
  return { ok: true, values, lists, ints, switches };
}
