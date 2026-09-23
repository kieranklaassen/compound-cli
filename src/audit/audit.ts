import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CompoundConfig } from "../config/ce-config.ts";
import { walkMarkdown } from "../corpus/learnings.ts";
import type { Workspace } from "../corpus/load.ts";
import { containedChildDirs, containedMdFiles, resolvePacks } from "../corpus/packs.ts";
import { UsageError } from "../errors.ts";
import { errorMessage } from "../util.ts";
import { type SplitDocument, splitDocument } from "./document.ts";
import { buildEffectiveSchema, type EffectiveSchema } from "./effective-schema.ts";
import type { FileAudit } from "./report.ts";
import {
  applyPolicy,
  type DocumentKind,
  type Finding,
  finding,
  type RuleContext,
  type RuleOptions,
  ruleOptions,
  runRules,
} from "./rules.ts";
import { buildVocabulary, type Vocabulary } from "./vocabulary.ts";

/** One file the audit read: where it is, what kind it is, and its split text. */
export type AuditedFile = {
  path: string;
  absPath: string;
  kind: DocumentKind;
  doc: SplitDocument;
  /** Declared pack files live in the shared cache and are never written. */
  writable: boolean;
  /** For pack files, the pack the file belongs to. */
  packId?: string;
};

/** One pack as the audit sees it: its README (if any) and its top-level rules. */
export type AuditedPack = {
  id: string;
  /** Repo-relative path of the pack directory (or the cache path for a declared pack). */
  path: string;
  readme: AuditedFile | null;
  rules: AuditedFile[];
  /** Pack-authoring mode (`--pack-dir`): a pack with no rule file is one CE would not publish. */
  authored: boolean;
};

export type AuditCorpus = {
  files: AuditedFile[];
  packs: AuditedPack[];
  /** What each kind's corpus already says; a pack repository's fixers read the packs' own values. */
  vocabularies: Record<DocumentKind, Vocabulary>;
  /** True when docs/solutions exists (even if empty). */
  hasSolutions: boolean;
  /** Repo-relative paths the config's `compound.audit.exclude` left out. */
  excluded: string[];
  config: CompoundConfig;
  options: RuleOptions;
  /** Problems in the config's `compound:` block or its schema declarations; the audit refuses to run on any. */
  configErrors: string[];
  warnings: string[];
};

export type LoadOptions = {
  /** Audit the rules and READMEs of the packs this repository declares. */
  packs: boolean;
  /** Pack-authoring mode: directories of packs, each child a pack with a README and rules. */
  packDirs: string[];
  /** An already built (and checked) schema; built from the config when absent. */
  schema?: EffectiveSchema;
};

/** The repository's effective schema and every problem in its declarations. */
export function schemaFor(config: CompoundConfig): { schema: EffectiveSchema; errors: string[] } {
  const build = buildEffectiveSchema(config.fields);
  return { schema: build.schema, errors: [...config.errors, ...build.errors] };
}

/** Read every learning (and, when asked, every pack) with the same boundary rules as find. */
export function loadAuditCorpus(workspace: Workspace, load: LoadOptions): AuditCorpus {
  const files: AuditedFile[] = [];
  const packs: AuditedPack[] = [];
  const warnings: string[] = [];
  const excluded: string[] = [];
  const config = workspace.config.compound;
  const solutionsDir = join(workspace.config.docsRootAbs, "solutions");
  let hasSolutions = false;
  try {
    const repoReal = realpathSync(workspace.repoRoot);
    const real = realpathSync(solutionsDir);
    hasSolutions = true;
    if (real === repoReal || real.startsWith(`${repoReal}/`)) {
      for (const absPath of walkMarkdown(solutionsDir)) {
        const path = relative(workspace.repoRoot, absPath);
        if (isExcluded(path, config.audit.exclude)) {
          excluded.push(path);
          continue;
        }
        const file = read(absPath, path, "solution", true, warnings);
        if (file) files.push(file);
      }
    } else {
      warnings.push(
        `skipped ${relative(workspace.repoRoot, solutionsDir)}: resolves outside the repository`,
      );
    }
  } catch {
    hasSolutions = false;
  }

  const addPack = (pack: AuditedPack) => {
    if (pack.readme) files.push(pack.readme);
    files.push(...pack.rules);
    packs.push(pack);
  };

  if (load.packs) {
    const resolution = resolvePacks(workspace.config, workspace.git);
    warnings.push(...resolution.warnings, ...resolution.errors);
    for (const root of resolution.roots) {
      addPack(readPack(root.id, root.dir, root.id, root.boundary, false, warnings));
    }
  }
  for (const dir of load.packDirs) {
    const abs = resolve(workspace.repoRoot, dir);
    const rel = relative(workspace.repoRoot, abs);
    let boundary: string;
    try {
      if (!statSync(abs).isDirectory()) throw new Error("not a directory");
      boundary = realpathSync(abs);
    } catch {
      throw new UsageError(`--pack-dir ${dir}: not a directory under ${workspace.repoRoot}`);
    }
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new UsageError(`--pack-dir ${dir}: resolves outside the repository`);
    }
    const escaped: string[] = [];
    const children = containedChildDirs(abs, boundary, escaped);
    for (const link of escaped) {
      warnings.push(`skipped ${relative(workspace.repoRoot, link)}: links outside ${rel}`);
    }
    if (!children.length) warnings.push(`${rel}: no pack directories`);
    for (const [name, child] of children) {
      addPack(readPack(name, child, `${rel}/${name}`, boundary, true, warnings));
    }
  }

  const built = load.schema ? { schema: load.schema, errors: [] } : schemaFor(config);
  const docsOf = (...kinds: DocumentKind[]) =>
    files.filter((f) => kinds.includes(f.kind)).map((f) => f.doc);
  return {
    files,
    packs,
    vocabularies: {
      solution: buildVocabulary(docsOf("solution")),
      pack_rule: buildVocabulary(docsOf("pack_rule")),
      // A README's tags should echo its rules', so a README chooses among the whole pack's values.
      pack_readme: buildVocabulary(docsOf("pack_rule", "pack_readme")),
    },
    hasSolutions,
    excluded,
    config,
    options: ruleOptions(config, built.schema),
    configErrors: built.errors,
    warnings,
  };
}

/** A pack directory: its README (if present) and every top-level Markdown file beside it. */
function readPack(
  id: string,
  dir: string,
  path: string,
  boundary: string,
  authored: boolean,
  warnings: string[],
): AuditedPack {
  const readmePath = join(dir, "README.md");
  const readme = existsSync(readmePath)
    ? read(readmePath, `${path}/README.md`, "pack_readme", authored, warnings, id)
    : undefined;
  const rules: AuditedFile[] = [];
  for (const absPath of containedMdFiles(dir, boundary, [])) {
    if (basename(absPath).toLowerCase() === "readme.md") continue;
    const file = read(absPath, `${path}/${basename(absPath)}`, "pack_rule", authored, warnings, id);
    if (file) rules.push(file);
  }
  return { id, path, readme: readme ?? null, rules, authored };
}

/** `compound.audit.exclude` names a file, or a directory with a trailing slash, relative to the repository. */
function isExcluded(path: string, exclude: string[]): boolean {
  return exclude.some((entry) => {
    const clean = entry.replace(/^\.\//, "");
    return clean.endsWith("/") ? path.startsWith(clean) : path === clean;
  });
}

function read(
  absPath: string,
  path: string,
  kind: DocumentKind,
  writable: boolean,
  warnings: string[],
  packId?: string,
): AuditedFile | undefined {
  try {
    const file: AuditedFile = {
      path,
      absPath,
      kind,
      doc: splitDocument(readFileSync(absPath, "utf8")),
      writable,
    };
    if (packId !== undefined) file.packId = packId;
    return file;
  } catch (error) {
    warnings.push(`skipped ${path}: ${errorMessage(error)}`);
    return undefined;
  }
}

/** The rule context for one file: its path, kind, pack, and the repository's policy. */
export function contextFor(file: AuditedFile, options: RuleOptions): RuleContext {
  const context: RuleContext = { path: file.path, kind: file.kind, options };
  if (file.packId !== undefined) context.packId = file.packId;
  return context;
}

/**
 * Rules only, no fixer: what doctor and the report-only audit share. Pack-level
 * findings (a README missing, a pack with no rules) ride on the README's entry.
 */
export function auditFiles(corpus: AuditCorpus): FileAudit[] {
  const audits: FileAudit[] = corpus.files.map((file) => ({
    path: file.path,
    kind: file.kind,
    findings: runRules(file.doc, contextFor(file, corpus.options)),
  }));
  for (const pack of corpus.packs) {
    const packFindings: Finding[] = [];
    if (!pack.readme) {
      packFindings.push(
        finding(
          "pack.readme_missing",
          "error",
          null,
          "the pack has no README.md; packs suggest judges a pack from its README frontmatter",
        ),
      );
    }
    if (pack.authored && pack.rules.length === 0) {
      packFindings.push(
        finding(
          "pack.no_rules",
          "error",
          null,
          "no top-level rule file beside the README; Compound Engineering would not publish this pack",
        ),
      );
    }
    if (!packFindings.length) continue;
    const readmePath = `${pack.path}/README.md`;
    const existing = audits.find((a) => a.path === readmePath);
    const applied = applyPolicy(packFindings, corpus.options);
    if (existing) existing.findings.push(...applied);
    else audits.push({ path: readmePath, kind: "pack_readme", findings: applied });
  }
  return audits;
}

/** `--stats`: how much of the corpus carries the fields the grep path and the judge read. */
export type AuditStats = {
  learnings: {
    total: number;
    /** Files whose frontmatter is missing, unterminated, or does not parse. */
    unparsable: number;
    with: Record<"title" | "applies_when" | "symptoms" | "tags", number>;
  };
  /** Packs audited (declared or under --pack-dir). */
  packs: number;
  /** Pack rules whose README barely carries their situation words; empty without packs. */
  readme_coverage: CoverageGap[];
};

export function auditStats(corpus: AuditCorpus): AuditStats {
  const learnings = corpus.files.filter((f) => f.kind === "solution");
  const with_ = { title: 0, applies_when: 0, symptoms: 0, tags: 0 };
  let unparsable = 0;
  for (const file of learnings) {
    const doc = file.doc;
    if (!doc.hasFrontmatter || doc.unterminated || doc.parseError) {
      unparsable++;
      continue;
    }
    for (const key of Object.keys(with_) as Array<keyof typeof with_>) {
      const value = doc.data[key];
      const present =
        typeof value === "string"
          ? value.trim().length > 0
          : Array.isArray(value) && value.length > 0;
      if (present) with_[key]++;
    }
  }
  return {
    learnings: { total: learnings.length, unparsable, with: with_ },
    packs: corpus.packs.length,
    readme_coverage: readmeCoverage(corpus.packs),
  };
}

/** A rule whose situation words the pack README barely carries. */
export type CoverageGap = {
  path: string;
  /** Share of the rule's situation words that appear in the README's title and applies_when. */
  ratio: number;
  /** Up to ten of the words the README lacks, sorted. */
  lacking: string[];
};

export const COVERAGE_FLOOR = 0.25;

const COVERAGE_STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being below
  between both but by can could did do does doing done down during each few for from further had has have having
  he her here hers him his how i if in into is it its itself just let like me more most my no nor not now of off
  on once only or other our ours out over own same she should so some such than that the their theirs them then
  there these they this those through to too under until up us very was we were what when where which while who
  whom why will with would you your yours add adds added adding make makes making use uses used using get gets got
  new one two via want need needs should must may might deciding decide decided choosing choose chose whether
  someone something wants every agent agents cora product design work decision decisions pack compound engineering
  writing capturing revising into onto than then with without`.split(/\s+/),
);

function coverageWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z][a-z0-9'-]+/g) ?? []) {
    if (token.length < 4 || COVERAGE_STOPWORDS.has(token)) continue;
    out.add(token.replace(/^['-]+|['-]+$/g, ""));
  }
  return out;
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * From validate-packs.py --coverage: rules sharing under a quarter of their
 * applies_when words with their README's title and applies_when. A guide for
 * aligning a README with its rules, never a failure.
 */
export function readmeCoverage(packs: AuditedPack[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const pack of packs) {
    if (!pack.readme || pack.readme.doc.parseError) continue;
    const readmeData = pack.readme.doc.data;
    const readmeWords = coverageWords(
      [String(readmeData.title ?? ""), ...stringItems(readmeData.applies_when)].join(" "),
    );
    for (const rule of pack.rules) {
      if (rule.doc.parseError) continue;
      const words = coverageWords(stringItems(rule.doc.data.applies_when).join(" "));
      if (!words.size) continue;
      const shared = [...words].filter((w) => readmeWords.has(w)).length;
      const ratio = shared / words.size;
      if (ratio >= COVERAGE_FLOOR) continue;
      gaps.push({
        path: rule.path,
        ratio: Math.round(ratio * 100) / 100,
        lacking: [...words]
          .filter((w) => !readmeWords.has(w))
          .sort()
          .slice(0, 10),
      });
    }
  }
  return gaps;
}
