import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { UsageError } from "../errors.ts";
import { errorMessage } from "../util.ts";

/**
 * Convert a JSON suite (compound-cli's `bench --cases` file, or compound-packs'
 * `tools/findability-bench/cases.json`) into a cases directory: one folder per
 * case with `query.md` and `expect.yaml`, and a `suite.yaml` with the corpus
 * pin and floors. Cassettes move as they are: a case that produces the same
 * request produces the same hash, so nothing is re-recorded.
 */

type JsonQuery = {
  activity?: string;
  concepts?: string[];
  decisions?: string[];
  domains?: string[];
  modules?: string[];
  paths?: string[];
  plan?: string;
  diff?: string;
};

type JsonCase = {
  id: string;
  query: JsonQuery;
  expected?: string[];
  expected_packs?: string[];
  negative?: boolean;
  near_miss?: boolean;
  near_miss_of?: string[];
  note?: string;
  source?: string;
  split?: string;
  pack?: string | null;
  tags?: string[];
};

type JsonSuite = {
  name?: string;
  description?: string;
  corpus?: { git?: string; ref?: string; docs_root?: string; path?: string } | null;
  floor?: Record<string, number>;
  floors?: Record<string, number>;
  cases: JsonCase[];
};

export type ImportOptions = {
  /** Where the case directories go. */
  out: string;
  /** Copy this cassette directory to `<out>/../cassettes/<suite name>` (or `cassettesOut`). */
  cassettes?: string;
  cassettesOut?: string;
  /** Rewrite plan pointers: a `plan` under `plansFrom` (a redacted copy) becomes the original under `plansTo` with `redact_citations: true`. */
  plansFrom?: string;
  plansTo?: string;
  /** Tags added to every case. */
  tags?: string[];
  /** Override the suite's corpus pin. */
  corpus?: { git?: string; ref?: string; docs_root?: string; path?: string };
  /** Write `kinds`, `packs_source`, `channels` for a repository of packs. */
  packs?: boolean;
  suggestThreshold?: number;
  threshold?: number;
};

export type ImportResult = {
  cases: number;
  suite: string;
  cassettes: number;
  skipped: string[];
};

export function importJsonSuite(jsonPath: string, options: ImportOptions): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (error) {
    throw new UsageError(`cannot read ${jsonPath}: ${errorMessage(error)}`);
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as JsonSuite).cases)) {
    throw new UsageError(`${jsonPath}: not a cases file (needs a "cases" array)`);
  }
  const suite = raw as JsonSuite;
  mkdirSync(options.out, { recursive: true });
  const skipped: string[] = [];
  let written = 0;
  const seen = new Set<string>();
  for (const c of suite.cases) {
    if (typeof c.id !== "string" || !c.query) {
      skipped.push(`case without id or query: ${JSON.stringify(c).slice(0, 80)}`);
      continue;
    }
    const id = safeId(c.id);
    if (seen.has(id)) {
      skipped.push(`duplicate id after normalisation: ${c.id}`);
      continue;
    }
    seen.add(id);
    const dir = join(options.out, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "query.md"), queryMarkdown(c, options));
    writeFileSync(join(dir, "expect.yaml"), expectYaml(c));
    written++;
  }

  // The directory names the suite, so cases/<corpus>/ and cassettes/<corpus>/ line up.
  const suiteName = basenameOf(options.out);
  const corpus = options.corpus ?? suite.corpus ?? undefined;
  const floors = { ...(suite.floor ?? {}), ...(suite.floors ?? {}) };
  const suiteDoc: Record<string, unknown> = { name: suiteName };
  if (suite.description) suiteDoc.description = suite.description;
  else if (suite.name) suiteDoc.description = `Imported from the ${suite.name} cases file.`;
  if (corpus) suiteDoc.corpus = corpus;
  if (Object.keys(floors).length) suiteDoc.floors = floors;
  let copied = 0;
  if (options.cassettes) {
    const target = options.cassettesOut ?? join(options.out, "..", "..", "cassettes", suiteName);
    mkdirSync(target, { recursive: true });
    cpSync(options.cassettes, target, { recursive: true });
    copied = readdirSync(target).filter((f) => f.endsWith(".json")).length;
    suiteDoc.cassettes = relativeFrom(options.out, target);
  }
  if (options.packs) {
    suiteDoc.kinds = ["pack_rule"];
    suiteDoc.packs_source = "packs";
    suiteDoc.channels = ["find", "suggest"];
  } else {
    // The bench judged a corpus's learnings and nothing else; the recorded requests assume that.
    suiteDoc.kinds = ["solution"];
  }
  if (options.threshold !== undefined) suiteDoc.threshold = options.threshold;
  if (options.suggestThreshold !== undefined) suiteDoc.suggest_threshold = options.suggestThreshold;
  const suitePath = join(options.out, "suite.yaml");
  if (!existsSync(suitePath)) writeFileSync(suitePath, stringify(suiteDoc));
  return { cases: written, suite: suitePath, cassettes: copied, skipped };
}

function basenameOf(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() ?? "suite";
}

function relativeFrom(from: string, to: string): string {
  const a = from.replace(/\/+$/, "").split("/");
  const b = to.replace(/\/+$/, "").split("/");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/") || ".";
}

/** A case id becomes a directory name: lowercase, hyphens, nothing a shell or a path minds. */
export function safeId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{3,}/g, "--")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
}

function queryMarkdown(c: JsonCase, options: ImportOptions): string {
  const fm: Record<string, unknown> = {};
  const tags = new Set<string>(options.tags ?? []);
  if (c.split) tags.add(c.split === "holdout" ? "heldout" : c.split);
  for (const t of c.tags ?? []) tags.add(t);
  if (c.id.endsWith("--title-summary")) tags.add("title-summary");
  else if (c.id.endsWith("--title-only")) tags.add("title-only");
  else if (c.id.startsWith("uncited-")) tags.add("uncited");
  else if (c.query.plan) tags.add("plan");
  if (c.near_miss) tags.add("near-miss");
  else if (c.negative) tags.add("negative");
  if (c.pack) tags.add(`pack:${c.pack}`);
  if (tags.size) fm.tags = [...tags];
  const q = c.query;
  if (q.plan) {
    let plan = q.plan;
    if (options.plansFrom && options.plansTo && plan.startsWith(options.plansFrom)) {
      plan = `${options.plansTo.replace(/\/+$/, "")}/${plan.slice(options.plansFrom.length).replace(/^\/+/, "")}`;
      fm.redact_citations = true;
    }
    fm.plan = plan;
  }
  if (q.diff) fm.diff = q.diff;
  for (const key of ["concepts", "decisions", "domains", "modules", "paths"] as const) {
    if (q[key]?.length) fm[key] = q[key];
  }
  if (c.note) fm.note = c.note;
  if (c.source) fm.source = c.source;
  const body = q.activity ? `${q.activity.trim()}\n` : "";
  return `---\n${stringify(fm)}---\n${body}`;
}

function expectYaml(c: JsonCase): string {
  const out: Record<string, unknown> = {};
  const hits = c.expected ?? [];
  const packs = c.expected_packs ?? [];
  if (hits.length) out.hits = hits;
  if (packs.length) out.packs = packs;
  if (c.near_miss_of?.length) out.near_miss = c.near_miss_of;
  if (!hits.length && !packs.length) out.nothing_relevant = true;
  return stringify(out);
}
