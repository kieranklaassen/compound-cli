import { HELP_OPTION, type OptionSpecs, parseCommandArgs, ROOT_OPTION } from "../args.ts";
import { auditFiles, loadAuditCorpus } from "../audit/audit.ts";
import { summarize } from "../audit/report.ts";
import { loadCeConfig } from "../config/ce-config.ts";
import { resolveRepoRoot } from "../config/repo-root.ts";
import type { Context } from "../context.ts";
import { hasAppliesWhen } from "../corpus/candidate.ts";
import { createGitCache } from "../corpus/git-cache.ts";
import { loadCorpus, type Workspace } from "../corpus/load.ts";
import { type KnownSource, knownSources, localSourceDir } from "../corpus/pack-sources.ts";
import { enumeratePacks } from "../corpus/packs.ts";
import { NotConfiguredError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { DOCTOR_HELP } from "../help.ts";
import { API_KEY_VARIABLE, cassetteMode, hasApiKey } from "../judge/api-key.ts";
import { homeDir } from "../util.ts";

const DOCTOR_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  json: { type: "boolean" },
  strict: { type: "boolean" },
  "no-sources": { type: "boolean" },
} as const satisfies OptionSpecs;

export type DoctorReport = {
  key: { variable: string; present: boolean; cassette_mode: string };
  repository: { root: string; resolved_by: string };
  docs_root: { path: string; source: string; solutions_dir: string; exists: boolean };
  learnings: {
    count: number;
    missing_applies_when: string[];
    missing_date: string[];
    malformed: Array<{ path: string; error: string }>;
  };
  /** The audit rules without a judge: what `compound audit` would report. */
  audit: {
    files: number;
    files_failing: number;
    errors: number;
    warnings: number;
    fixable: number;
  };
  packs: {
    entries: number;
    roots: Array<{
      id: string;
      dir: string;
      rules: number;
      nested_rule_shaped: number;
      url: string | null;
      ref: string | null;
      cached_commit: string | null;
      remote_commit: string | null;
      drift: "current" | "stale" | "unknown" | null;
    }>;
    warnings: string[];
    errors: string[];
  };
  known_sources: Array<{
    source: string;
    kind: KnownSource["kind"];
    status: string;
    packs: number | null;
  }>;
  cache: string | null;
};

export async function run(argv: string[], ctx: Context): Promise<number> {
  const parsed = parseCommandArgs(argv, DOCTOR_OPTIONS);
  if (parsed.values.help) {
    ctx.stdout(DOCTOR_HELP);
    return EXIT.OK;
  }
  const report = buildReport(ctx, parsed.values.root, !parsed.values["no-sources"]);
  if (parsed.values.json) ctx.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else ctx.stdout(renderDoctor(report));
  if (parsed.values.strict && !report.key.present) throw new NotConfiguredError(API_KEY_VARIABLE);
  return EXIT.OK;
}

export function buildReport(
  ctx: Context,
  rootOverride: string | undefined,
  checkSources: boolean,
): DoctorReport {
  const repo = resolveRepoRoot(ctx.cwd, rootOverride);
  const config = loadCeConfig(repo.root);
  const git = createGitCache(ctx.env);
  const {
    learnings,
    packs: resolution,
    packRules: rules,
  } = loadCorpus({ repoRoot: repo.root, config, git });

  const roots = resolution.roots.map((root) => {
    const cached = root.url ? git.headCommit(root.dir) : null;
    const remote =
      root.url && root.ref && checkSources ? (git.lsRemote(root.url, root.ref) ?? null) : null;
    let drift: DoctorReport["packs"]["roots"][number]["drift"] = null;
    if (root.url) drift = cached && remote ? (cached === remote ? "current" : "stale") : "unknown";
    return {
      id: root.id,
      dir: root.dir,
      rules: rules.candidates.filter((c) => c.packId === root.id).length,
      nested_rule_shaped: root.nested_rule_shaped,
      url: root.url ?? null,
      ref: root.ref ?? null,
      cached_commit: cached ?? null,
      remote_commit: remote,
      drift,
    };
  });

  const home = homeDir(ctx.env);
  const sources = knownSources(config, ctx.env).map((source) => {
    if (source.kind === "local") {
      const dir = localSourceDir(source.source, repo.root, home);
      return {
        source: source.source,
        kind: source.kind,
        status: dir ? "present" : "missing",
        packs: dir ? enumeratePacks(dir, dir, []).size : null,
      };
    }
    const ref = source.ref ?? "main";
    const cached = git.cachedDir(source.source, ref);
    if (!checkSources) {
      return {
        source: `${source.source}@${ref}`,
        kind: source.kind,
        status: cached ? "cached" : "not checked",
        packs: null,
      };
    }
    const remote = git.lsRemote(source.source, ref);
    return {
      source: `${source.source}@${ref}`,
      kind: source.kind,
      status: `${remote ? "reachable" : "unreachable"}${cached ? ", cached" : ""}`,
      packs: null,
    };
  });

  return {
    key: {
      variable: API_KEY_VARIABLE,
      present: hasApiKey(ctx.env),
      cassette_mode: cassetteMode(ctx.env),
    },
    repository: { root: repo.root, resolved_by: repo.source },
    docs_root: {
      path: config.docsRoot,
      source: config.docsRootSource,
      solutions_dir: learnings.solutionsDir,
      exists: learnings.exists,
    },
    learnings: {
      count: learnings.candidates.length,
      missing_applies_when: learnings.candidates
        .filter((c) => !hasAppliesWhen(c))
        .map((c) => c.path),
      missing_date: learnings.candidates.filter((c) => !c.frontmatter.date).map((c) => c.path),
      malformed: learnings.malformed,
    },
    audit: auditCounts({ repoRoot: repo.root, config, git }),
    packs: {
      entries: resolution.entries,
      roots,
      warnings: [...resolution.warnings, ...rules.warnings],
      errors: resolution.errors,
    },
    known_sources: sources,
    cache: git.base ?? null,
  };
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = ["compound doctor", ""];
  lines.push(
    `${report.key.variable}: ${report.key.present ? "present" : "missing"}${report.key.cassette_mode !== "off" ? ` (cassette mode ${report.key.cassette_mode})` : ""}`,
  );
  lines.push(`repository: ${report.repository.root} (${report.repository.resolved_by})`);
  lines.push(`docs root: ${report.docs_root.path} (${report.docs_root.source})`);
  lines.push("");
  const l = report.learnings;
  lines.push(
    `learnings: ${l.count} under ${report.docs_root.solutions_dir}${report.docs_root.exists ? "" : " (directory missing)"}`,
  );
  lines.push(`  missing applies_when: ${l.missing_applies_when.length}`);
  for (const path of l.missing_applies_when) lines.push(`    ${path}`);
  lines.push(`  missing date: ${l.missing_date.length}`);
  for (const path of l.missing_date) lines.push(`    ${path}`);
  lines.push(`  malformed frontmatter: ${l.malformed.length}`);
  for (const item of l.malformed) lines.push(`    ${item.path}: ${item.error}`);
  lines.push("");
  const a = report.audit;
  lines.push(
    `audit: ${a.files} files, ${a.files_failing} failing, ${a.errors} errors, ${a.warnings} warnings, ${a.fixable} fixable${a.files_failing ? " (run `compound audit` for the list, `compound audit --fix` to repair)" : ""}`,
  );
  lines.push("");
  lines.push(
    `packs: ${report.packs.entries} ${report.packs.entries === 1 ? "entry" : "entries"}, ${report.packs.roots.length} resolved`,
  );
  for (const root of report.packs.roots) {
    const origin = root.url ? `${root.url}@${root.ref}` : root.dir;
    const drift = root.drift
      ? `, ${root.drift}${root.drift === "stale" ? ` (cached ${root.cached_commit?.slice(0, 7)}, remote ${root.remote_commit?.slice(0, 7)})` : ""}`
      : "";
    const nested = root.nested_rule_shaped ? `, ${root.nested_rule_shaped} nested rule-shaped` : "";
    lines.push(`  ${root.id}: ${root.rules} rules${nested}${drift}  ${origin}`);
  }
  for (const warning of report.packs.warnings) lines.push(`  warning: ${warning}`);
  for (const error of report.packs.errors) lines.push(`  error: ${error}`);
  lines.push("");
  lines.push("known sources:");
  for (const source of report.known_sources) {
    lines.push(
      `  ${source.source}: ${source.status}${source.packs !== null ? ` (${source.packs} packs)` : ""}`,
    );
  }
  lines.push(`cache: ${report.cache ?? "unavailable"}`);
  return `${lines.join("\n")}\n`;
}

function auditCounts(workspace: Workspace): DoctorReport["audit"] {
  const corpus = loadAuditCorpus(workspace, { packs: false, packDirs: [] });
  const summary = summarize(auditFiles(corpus), corpus.config.audit.strict);
  return {
    files: summary.files,
    files_failing: summary.files_failing,
    errors: summary.errors,
    warnings: summary.warnings,
    fixable: summary.fixable,
  };
}
