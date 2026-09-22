import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  HELP_OPTION,
  type OptionSpecs,
  parseCommandArgs,
  ROOT_OPTION,
  requireProbability,
} from "../args.ts";
import { type BenchCase, type CasesFile, readCasesFile } from "../bench/cases.ts";
import {
  aggregate,
  type BenchReport,
  type CaseRun,
  type CaseScore,
  floorFailures,
  latencyStats,
  scoreCase,
} from "../bench/score.ts";
import type { CeConfig } from "../config/ce-config.ts";
import type { Context } from "../context.ts";
import { createGitCache } from "../corpus/git-cache.ts";
import { loadCorpus, type Workspace } from "../corpus/load.ts";
import { MissingCorpusError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { NO_FILTERS } from "../find/filters.ts";
import { type JudgeSettings, runFind } from "../find/find.ts";
import { BENCH_HELP } from "../help.ts";
import { buildWorkState } from "../input/work-state.ts";
import { CASSETTE_DIR_VARIABLE, cassetteMode } from "../judge/api-key.ts";
import { judgeFromEnv } from "../judge/client.ts";
import { resolveJudgeSettings } from "./find-options.ts";

const BENCH_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  cases: { type: "string" },
  json: { type: "boolean" },
  out: { type: "string" },
  threshold: { type: "string" },
  "tier-one-threshold": { type: "string" },
  sweep: { type: "string" },
  "frontmatter-only": { type: "boolean" },
  "enforce-floor": { type: "boolean" },
  batch: { type: "string" },
  parallel: { type: "string" },
  "excerpt-chars": { type: "string" },
  model: { type: "string" },
  only: { type: "string", multiple: true },
} as const satisfies OptionSpecs;

/** Corpus clones may take longer than a skill call; give them two minutes. */
const CORPUS_CLONE_TIMEOUT_SECONDS = 120;

export async function run(argv: string[], ctx: Context): Promise<number> {
  const parsed = parseCommandArgs(argv, BENCH_OPTIONS);
  const v = parsed.values;
  if (v.help) {
    ctx.stdout(BENCH_HELP);
    return EXIT.OK;
  }
  if (!v.cases) throw new UsageError("bench requires --cases <file>");
  const casesPath = resolve(ctx.cwd, v.cases);
  const file = readCasesFile(casesPath);
  const settings = resolveJudgeSettings(v);
  const sweep = (v.sweep ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => requireProbability("sweep", s, 0));
  const only = new Set(v.only ?? []);

  const judge = judgeFromEnv(ctx.env, { model: settings.model, parallel: settings.parallel });
  const workspace = benchWorkspace(file, ctx, v.root);
  const cases = only.size ? file.cases.filter((c) => only.has(c.id)) : file.cases;
  if (cases.length === 0) throw new UsageError("no cases selected");

  const corpus = loadCorpus(workspace);
  const corpusPaths = new Set([
    ...corpus.learnings.candidates.map((c) => c.path),
    ...corpus.packRules.candidates.map((c) => c.path),
  ]);
  const runs: CaseRun[] = [];
  const warnings = new Set<string>(corpus.warnings);
  const mode = cassetteMode(ctx.env);
  const manifest = readManifest(ctx, mode);
  const thresholdDrift =
    manifest !== undefined && mode === "replay" && manifest.threshold !== settings.threshold;
  if (thresholdDrift) {
    warnings.add(
      `cassettes were recorded at threshold ${manifest.threshold}; this run scores at ${settings.threshold} (recordings do not depend on the threshold, so the floor may not mean what it did)`,
    );
  }
  for (const benchCase of cases) {
    const before = judge.usage.snapshot();
    const started = performance.now();
    const run = await runFind({
      workspace,
      state: await buildWorkState(toChannels(benchCase), ctx),
      judge,
      settings,
      filters: NO_FILTERS,
      mode: "find",
      corpus,
    });
    const after = judge.usage.snapshot();
    for (const warning of run.result.warnings) warnings.add(warning);
    const caseRun: CaseRun = {
      benchCase,
      run,
      corpusPaths,
      wall_ms: Math.round(performance.now() - started),
      requests: after.requests - before.requests,
      input_tokens: after.input_tokens - before.input_tokens,
      estimated_usd: Number((after.estimated_usd - before.estimated_usd).toFixed(8)),
    };
    runs.push(caseRun);
    if (!v.json) ctx.stderr(`${progressLine(caseRun, settings.threshold)}\n`);
  }

  const scores = runs.map((r) => scoreCase(r, settings.threshold));
  const usage = judge.usage.snapshot();
  const report: BenchReport = {
    schema_version: 1,
    name: file.name,
    threshold: settings.threshold,
    aggregate: aggregate(scores, settings.threshold),
    sweep: sweep.map((t) =>
      aggregate(
        runs.map((r) => scoreCase(r, t)),
        t,
      ),
    ),
    cases: scores,
    latency_ms: latencyStats(runs.map((r) => r.wall_ms)),
    cost: {
      total_usd: usage.estimated_usd,
      mean_usd: runs.length ? Number((usage.estimated_usd / runs.length).toFixed(8)) : 0,
      requests: usage.requests,
      input_tokens: usage.input_tokens,
    },
    corpus: {
      root: workspace.repoRoot,
      solutions: corpus.learnings.candidates.length,
      pack_rules: corpus.packRules.candidates.length,
    },
    model: usage.model,
    cassette_mode: mode,
    warnings: [...warnings],
  };
  if (mode === "record") writeManifest(ctx, settings, report.model);

  if (v.out) {
    const outPath = resolve(ctx.cwd, v.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (v.json) ctx.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else ctx.stdout(renderBench(report));

  if (v["enforce-floor"]) {
    const failures = floorFailures(report.aggregate, file.floor ?? {});
    if (thresholdDrift) {
      failures.push(
        `threshold ${settings.threshold} differs from the recorded ${manifest.threshold}`,
      );
    }
    if (failures.length) {
      for (const failure of failures) ctx.stderr(`compound bench: ${failure}\n`);
      return EXIT.INTERNAL;
    }
  }
  return EXIT.OK;
}

/**
 * The bench judges the cases file's corpus and nothing else: the corpus block
 * (or --root) names the checkout, the repo's own CE config is not read, and no
 * known pack source is consulted, so a run is reproducible from cassettes.
 */
function benchWorkspace(
  file: CasesFile,
  ctx: Context,
  rootOverride: string | undefined,
): Workspace {
  const git = createGitCache(ctx.env, {
    defaultTimeoutSeconds: CORPUS_CLONE_TIMEOUT_SECONDS,
  });
  let repoRoot: string;
  if (rootOverride !== undefined) {
    repoRoot = resolve(ctx.cwd, rootOverride);
  } else if (file.corpus) {
    const warnings: string[] = [];
    const dir = git.clone(file.corpus.git, file.corpus.ref, `corpus ${file.name}`, warnings);
    if (!dir) throw new MissingCorpusError(`${file.corpus.git}@${file.corpus.ref}`, warnings);
    repoRoot = dir;
  } else {
    throw new UsageError("the cases file has no corpus block; pass --root <checkout>");
  }
  const docsRoot = file.corpus?.docs_root ?? "docs";
  const config: CeConfig = {
    repoRoot,
    docsRoot,
    docsRootAbs: resolve(repoRoot, docsRoot),
    docsRootSource: "default",
    packs: [],
    packSources: [],
    errors: [],
  };
  return { repoRoot, config, git };
}

function toChannels(benchCase: BenchCase) {
  const q = benchCase.query;
  return {
    activity: q.activity,
    concepts: q.concepts ?? [],
    decisions: q.decisions ?? [],
    domains: q.domains ?? [],
    modules: q.modules ?? [],
    paths: q.paths ?? [],
    diffPath: undefined,
    planPath: undefined,
    docPath: undefined,
  };
}

function progressLine(caseRun: CaseRun, threshold: number): string {
  const score = scoreCase(caseRun, threshold);
  const outcome = score.negative
    ? score.correct_negative
      ? "ok (nothing relevant)"
      : `FALSE HIT ${score.hits.length}`
    : score.recall === 1
      ? "ok"
      : `MISS ${score.missed.map((m) => `${m.path.split("/").pop()} (score ${m.score ?? "-"}, t1 ${m.tier_one_score}, rank ${m.rank ?? "-"})`).join(", ")}`;
  return `${score.id.padEnd(44)} ${outcome}  ${caseRun.wall_ms} ms, $${caseRun.estimated_usd.toFixed(5)}`;
}

export function renderBench(report: BenchReport): string {
  const a = report.aggregate;
  const lines: string[] = [];
  lines.push(
    `compound bench: ${report.name} at threshold ${report.threshold}${report.cassette_mode !== "off" ? ` (cassette ${report.cassette_mode})` : ""}`,
  );
  lines.push(
    `corpus: ${report.corpus.solutions} learnings, ${report.corpus.pack_rules} pack rules at ${report.corpus.root}`,
  );
  lines.push("");
  lines.push(
    `macro recall           ${pct(a.macro_recall)}   (${a.positive_cases} positive cases)`,
  );
  lines.push(`micro recall           ${pct(a.micro_recall)}`);
  lines.push(
    `precision lower bound  ${pct(a.precision_lower_bound)}   (labels are positive-only; extra hits are unjudged)`,
  );
  lines.push(
    `negatives correct      ${pct(a.negatives_correct)}   (${a.negative_cases} negative cases)`,
  );
  lines.push(`perfect cases          ${a.perfect_cases} of ${a.cases}`);
  if (a.labeling_errors)
    lines.push(`labeling errors        ${a.labeling_errors} expected paths not in the corpus`);
  lines.push("");
  const l = report.latency_ms;
  lines.push(`latency per case       median ${l.median} ms, p90 ${l.p90} ms, mean ${l.mean} ms`);
  lines.push(
    `cost                   $${report.cost.total_usd.toFixed(4)} total, $${report.cost.mean_usd.toFixed(5)} per case, ${report.cost.requests} requests, ${report.cost.input_tokens.toLocaleString("en-US")} input tokens${report.model ? `, model ${report.model}` : ""}`,
  );
  if (report.sweep.length) {
    lines.push("", "threshold sweep");
    lines.push("  threshold  macro  micro  precision_lb  negatives");
    for (const s of report.sweep) {
      lines.push(
        `  ${String(s.threshold).padEnd(9)}  ${pct(s.macro_recall).padEnd(5)}  ${pct(s.micro_recall).padEnd(5)}  ${pct(s.precision_lower_bound).padEnd(12)}  ${pct(s.negatives_correct)}`,
      );
    }
  }
  const misses = report.cases.filter(
    (c) => (c.recall !== null && c.recall < 1) || c.correct_negative === false,
  );
  if (misses.length) {
    lines.push("", "misses and false hits");
    for (const c of misses) lines.push(...renderMiss(c));
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function renderMiss(score: CaseScore): string[] {
  if (score.negative)
    return [
      `  ${score.id}: ${score.hits.length} hits where none were expected: ${score.hits.slice(0, 3).join(", ")}`,
    ];
  return score.missed.map(
    (m) =>
      `  ${score.id}: missed ${m.path} (score ${m.score ?? "not confirmed"}, tier one ${m.tier_one_score}, rank ${m.rank ?? "-"})`,
  );
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

type Manifest = {
  recorded_at: string;
  threshold: number;
  tier_one_threshold: number;
  model_requested: string;
  model_answered: string | null;
};

/**
 * Recorded answers do not depend on the threshold, so a replay would stay green
 * after a threshold change; the manifest pins the threshold the recording was
 * scored at so `--enforce-floor` can notice.
 */
function manifestPath(ctx: Context): string | undefined {
  const dir = ctx.env[CASSETTE_DIR_VARIABLE]?.trim();
  return dir ? resolve(ctx.cwd, dir, "manifest.json") : undefined;
}

function readManifest(ctx: Context, mode: string): Manifest | undefined {
  if (mode === "off") return undefined;
  const path = manifestPath(ctx);
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

function writeManifest(ctx: Context, settings: JudgeSettings, model: string | null): void {
  const path = manifestPath(ctx);
  if (!path) return;
  const manifest: Manifest = {
    recorded_at: new Date().toISOString(),
    threshold: settings.threshold,
    tier_one_threshold: settings.tierOneThreshold,
    model_requested: settings.model,
    model_answered: model,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
