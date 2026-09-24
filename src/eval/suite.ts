import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { UsageError } from "../errors.ts";
import { errorMessage } from "../util.ts";

/**
 * A cases collection: a tree of directories where a `suite.yaml` at any level
 * sets the corpus, floors, and cassettes for the cases below it, and a case is
 * a directory holding `query.md` (frontmatter plus the activity as the body)
 * and `expect.yaml`. A case is a pointer plus an expectation; the corpus is
 * fetched at its pinned SHA when the case runs, so no corpus text is copied.
 */

export type CorpusPin = {
  /** A git URL cloned at `ref` through the pack cache. */
  git?: string;
  ref?: string;
  /** A local directory (a vendored mirror), relative to the suite.yaml that names it. */
  path?: string;
  docs_root?: string;
  /** The secret CI uses to read a private corpus; informational. */
  token?: string;
};

export type Floors = {
  macro_recall?: number;
  negatives_correct?: number;
  precision_lower_bound?: number;
  suggest_macro_recall?: number;
  near_miss_correct?: number;
};

export type Channel = "find" | "suggest";

export type SuiteConfig = {
  name: string;
  description?: string;
  corpus: CorpusPin | null;
  floors: Floors;
  /** Cassette directory, resolved to an absolute path. */
  cassettes: string | null;
  /** Restrict `find` candidates to these kinds (a repository of packs judges `pack_rule` only). */
  kinds: Array<"solution" | "pack_rule"> | null;
  /** The directory of packs `suggest` judges, relative to the corpus root (a repository of packs). */
  packs_source: string | null;
  threshold: number | null;
  suggest_threshold: number | null;
  /** Channels a `nothing_relevant` case runs when its expectation names neither. */
  channels: Channel[];
  /** Where this suite's settings were read, for messages. */
  file: string;
};

export type EvalQuery = {
  activity?: string;
  concepts: string[];
  decisions: string[];
  domains: string[];
  modules: string[];
  paths: string[];
  /** Relative to the corpus root. */
  plan?: string;
  /** Drop every plan line that names a learning by path before the judge reads it. */
  redact_citations: boolean;
  /** Relative to the case directory. */
  diff?: string;
};

export type Expectation = {
  /** Learnings (repo-relative) and pack rules (`<pack-id>/<file>`) that must surface. */
  hits: string[];
  /** Packs `suggest` must propose. */
  packs: string[];
  /** Paths or pack ids that must not surface. */
  near_miss: string[];
  nothing_relevant: boolean;
};

export type EvalCase = {
  /** Directory path relative to the eval root, the case's id. */
  id: string;
  dir: string;
  tags: string[];
  note?: string;
  source?: string;
  query: EvalQuery;
  expect: Expectation;
  /** The nearest suite, with any case-level corpus override applied. */
  suite: SuiteConfig;
  channels: Channel[];
  /** An adversarial negative: work that shares vocabulary with a pack or learning on purpose. */
  nearMiss: boolean;
};

const ROOT_DEFAULTS: SuiteConfig = {
  name: "evals",
  corpus: null,
  floors: {},
  cassettes: null,
  kinds: null,
  packs_source: null,
  threshold: null,
  suggest_threshold: null,
  channels: ["find"],
  file: "(defaults)",
};

/** Every case under `root`, each with its effective suite. */
export function loadCases(root: string): { cases: EvalCase[]; suites: SuiteConfig[] } {
  const rootAbs = resolve(root);
  if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
    throw new UsageError(`${root}: not a directory of cases`);
  }
  const cases: EvalCase[] = [];
  const suites: SuiteConfig[] = [];
  const walk = (dir: string, inherited: SuiteConfig) => {
    const suite = existsSync(join(dir, "suite.yaml"))
      ? readSuite(join(dir, "suite.yaml"), inherited)
      : inherited;
    if (suite !== inherited) suites.push(suite);
    if (existsSync(join(dir, "query.md"))) {
      cases.push(readCase(dir, relative(rootAbs, dir) || basename(dir), suite));
      return;
    }
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || name === "cassettes" || name === "node_modules") continue;
      const child = join(dir, name);
      if (statSync(child).isDirectory()) walk(child, suite);
    }
  };
  walk(rootAbs, ROOT_DEFAULTS);
  return { cases, suites };
}

function readYaml(path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`${path}: ${errorMessage(error).split("\n")[0]}`);
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`${path}: must be a YAML mapping`);
  }
  return raw as Record<string, unknown>;
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new UsageError(`${where}: must be a list of strings`);
  }
  return value;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new UsageError(`${where}: must be a string`);
  return value;
}

function optionalNumber(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UsageError(`${where}: must be a number`);
  }
  return value;
}

export function readCorpusPin(value: unknown, where: string, baseDir: string): CorpusPin | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${where}: corpus must be a mapping with git and ref, or path`);
  }
  const raw = value as Record<string, unknown>;
  const pin: CorpusPin = {};
  const git = optionalString(raw.git, `${where}.git`);
  const ref = optionalString(raw.ref, `${where}.ref`);
  const path = optionalString(raw.path, `${where}.path`);
  if (git !== undefined) pin.git = git;
  if (ref !== undefined) pin.ref = ref;
  if (path !== undefined) pin.path = resolve(baseDir, path);
  const docsRoot = optionalString(raw.docs_root, `${where}.docs_root`);
  if (docsRoot !== undefined) pin.docs_root = docsRoot;
  const token = optionalString(raw.token, `${where}.token`);
  if (token !== undefined) pin.token = token;
  if (pin.git !== undefined && pin.ref === undefined) {
    throw new UsageError(`${where}: a git corpus needs a ref (a commit SHA)`);
  }
  if (pin.git === undefined && pin.path === undefined) {
    throw new UsageError(`${where}: corpus needs git and ref, or path`);
  }
  return pin;
}

function readFloors(value: unknown, where: string): Floors {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${where}: floors must be a mapping`);
  }
  const raw = value as Record<string, unknown>;
  const floors: Floors = {};
  for (const key of [
    "macro_recall",
    "negatives_correct",
    "precision_lower_bound",
    "suggest_macro_recall",
    "near_miss_correct",
  ] as const) {
    const n = optionalNumber(raw[key], `${where}.${key}`);
    if (n !== undefined) floors[key] = n;
  }
  return floors;
}

function readSuite(path: string, inherited: SuiteConfig): SuiteConfig {
  const raw = readYaml(path);
  const dir = dirname(path);
  const known = new Set([
    "name",
    "description",
    "corpus",
    "floors",
    "floor",
    "cassettes",
    "kinds",
    "packs_source",
    "threshold",
    "suggest_threshold",
    "channels",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new UsageError(`${path}: unknown key \`${key}\``);
  }
  const corpus = readCorpusPin(raw.corpus, `${path}: corpus`, dir);
  const cassettes = optionalString(raw.cassettes, `${path}: cassettes`);
  const kinds = raw.kinds === undefined ? undefined : stringList(raw.kinds, `${path}: kinds`);
  for (const kind of kinds ?? []) {
    if (kind !== "solution" && kind !== "pack_rule") {
      throw new UsageError(`${path}: kinds must be solution or pack_rule`);
    }
  }
  const channels =
    raw.channels === undefined ? undefined : stringList(raw.channels, `${path}: channels`);
  for (const channel of channels ?? []) {
    if (channel !== "find" && channel !== "suggest") {
      throw new UsageError(`${path}: channels must be find or suggest`);
    }
  }
  const suite: SuiteConfig = {
    name: optionalString(raw.name, `${path}: name`) ?? basename(dir),
    corpus: corpus ?? inherited.corpus,
    floors: { ...inherited.floors, ...readFloors(raw.floors ?? raw.floor, `${path}: floors`) },
    cassettes: cassettes === undefined ? inherited.cassettes : resolve(dir, cassettes),
    kinds: kinds === undefined ? inherited.kinds : (kinds as SuiteConfig["kinds"]),
    packs_source:
      optionalString(raw.packs_source, `${path}: packs_source`) ?? inherited.packs_source,
    threshold: optionalNumber(raw.threshold, `${path}: threshold`) ?? inherited.threshold,
    suggest_threshold:
      optionalNumber(raw.suggest_threshold, `${path}: suggest_threshold`) ??
      inherited.suggest_threshold,
    channels: (channels as Channel[] | undefined) ?? inherited.channels,
    file: path,
  };
  const description = optionalString(raw.description, `${path}: description`);
  if (description !== undefined) suite.description = description;
  return suite;
}

/** `query.md`: frontmatter for the channels and metadata, the activity sentence as the body. */
export function readQueryFile(
  text: string,
  where: string,
): {
  frontmatter: Record<string, unknown>;
  activity: string | undefined;
} {
  const lines = text.split(/\r?\n/);
  let frontmatter: Record<string, unknown> = {};
  let body = text;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end === -1) throw new UsageError(`${where}: frontmatter never closes`);
    const block = lines.slice(1, end).join("\n");
    try {
      const parsed = block.trim() ? parse(block) : {};
      if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
        throw new Error("frontmatter is not a mapping");
      }
      frontmatter = (parsed ?? {}) as Record<string, unknown>;
    } catch (error) {
      throw new UsageError(`${where}: ${errorMessage(error).split("\n")[0]}`);
    }
    body = lines.slice(end + 1).join("\n");
  }
  const activity = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return { frontmatter, activity: activity || undefined };
}

function readCase(dir: string, id: string, inherited: SuiteConfig): EvalCase {
  const queryPath = join(dir, "query.md");
  const expectPath = join(dir, "expect.yaml");
  if (!existsSync(expectPath)) throw new UsageError(`${id}: expect.yaml is missing`);
  const { frontmatter, activity } = readQueryFile(readFileSync(queryPath, "utf8"), queryPath);
  const where = `${id}/query.md`;
  const known = new Set([
    "kind",
    "tags",
    "note",
    "source",
    "plan",
    "redact_citations",
    "diff",
    "concepts",
    "decisions",
    "domains",
    "modules",
    "paths",
    "corpus",
  ]);
  for (const key of Object.keys(frontmatter)) {
    if (!known.has(key)) throw new UsageError(`${where}: unknown key \`${key}\``);
  }
  const query: EvalQuery = {
    concepts: stringList(frontmatter.concepts, `${where}: concepts`),
    decisions: stringList(frontmatter.decisions, `${where}: decisions`),
    domains: stringList(frontmatter.domains, `${where}: domains`),
    modules: stringList(frontmatter.modules, `${where}: modules`),
    paths: stringList(frontmatter.paths, `${where}: paths`),
    redact_citations: frontmatter.redact_citations === true,
  };
  if (activity !== undefined) query.activity = activity;
  const plan = optionalString(frontmatter.plan, `${where}: plan`);
  if (plan !== undefined) query.plan = plan;
  const diff = optionalString(frontmatter.diff, `${where}: diff`);
  if (diff !== undefined) query.diff = diff;
  if (
    query.activity === undefined &&
    query.plan === undefined &&
    query.diff === undefined &&
    !query.concepts.length &&
    !query.decisions.length &&
    !query.domains.length &&
    !query.modules.length &&
    !query.paths.length
  ) {
    throw new UsageError(
      `${where}: the case has no query (an activity body, a plan, a diff, or a channel)`,
    );
  }

  const rawExpect = readYaml(expectPath);
  for (const key of Object.keys(rawExpect)) {
    if (!["hits", "packs", "near_miss", "nothing_relevant"].includes(key)) {
      throw new UsageError(`${id}/expect.yaml: unknown key \`${key}\``);
    }
  }
  const expect: Expectation = {
    hits: stringList(rawExpect.hits, `${id}/expect.yaml: hits`),
    packs: stringList(rawExpect.packs, `${id}/expect.yaml: packs`),
    near_miss: stringList(rawExpect.near_miss, `${id}/expect.yaml: near_miss`),
    nothing_relevant: rawExpect.nothing_relevant === true,
  };
  if (expect.nothing_relevant && (expect.hits.length || expect.packs.length)) {
    throw new UsageError(`${id}/expect.yaml: nothing_relevant cannot come with hits or packs`);
  }
  if (!expect.nothing_relevant && !expect.hits.length && !expect.packs.length) {
    throw new UsageError(
      `${id}/expect.yaml: expect hits, packs, or nothing_relevant: true (a case must expect something)`,
    );
  }

  const suiteOverride = readCorpusPin(frontmatter.corpus, `${where}: corpus`, dir);
  const suite = suiteOverride ? { ...inherited, corpus: suiteOverride } : inherited;
  if (!suite.corpus)
    throw new UsageError(`${id}: no corpus is pinned (add corpus to a suite.yaml or the case)`);

  const kind = optionalString(frontmatter.kind, `${where}: kind`);
  const channels = new Set<Channel>();
  if (kind === "find" || kind === "gate") channels.add("find");
  else if (kind === "packs" || kind === "suggest") channels.add("suggest");
  else if (kind !== undefined) throw new UsageError(`${where}: kind must be find or packs`);
  if (expect.hits.length || expect.near_miss.some((n) => n.includes("/"))) channels.add("find");
  if (expect.packs.length || expect.near_miss.some((n) => !n.includes("/")))
    channels.add("suggest");
  // Nothing relevant means nothing on any channel the suite runs, near misses included.
  if (expect.nothing_relevant || !channels.size) {
    for (const channel of suite.channels) channels.add(channel);
  }

  const result: EvalCase = {
    id,
    dir,
    tags: stringList(frontmatter.tags, `${where}: tags`),
    query,
    expect,
    suite,
    channels: [...channels],
    nearMiss: expect.nothing_relevant && expect.near_miss.length > 0,
  };
  const note = optionalString(frontmatter.note, `${where}: note`);
  if (note !== undefined) result.note = note;
  const source = optionalString(frontmatter.source, `${where}: source`);
  if (source !== undefined) result.source = source;
  return result;
}

/** Lines that name a learning by path: where citation labels come from, so the judge never sees them. */
export const CITATION_LINE = /^.*solutions\/[A-Za-z0-9_./-]*\.md.*$/gm;

export function redactCitations(text: string): string {
  return text.replace(CITATION_LINE, "");
}
