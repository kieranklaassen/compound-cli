import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type Aggregate,
  aggregate,
  type CaseRun,
  type CaseScore,
  fBeta,
  floorFailures,
  latencyStats,
  scoreCase,
} from "../bench/score.ts";
import { type CeConfig, loadCeConfig } from "../config/ce-config.ts";
import type { Context } from "../context.ts";
import { createGitCache, type GitCache } from "../corpus/git-cache.ts";
import { type CorpusLoad, loadCorpus, type Workspace } from "../corpus/load.ts";
import { loadPackCandidatesFrom } from "../corpus/pack-sources.ts";
import { CliError, MissingCorpusError, UsageError } from "../errors.ts";
import { NO_FILTERS } from "../find/filters.ts";
import { type JudgeSettings, runFind } from "../find/find.ts";
import { judgePackCandidates } from "../find/tier-one.ts";
import { buildWorkState, judgeState } from "../input/work-state.ts";
import {
  CASSETTE_DIR_VARIABLE,
  CASSETTE_MODE_VARIABLE,
  type CassetteMode,
  hasApiKey,
} from "../judge/api-key.ts";
import { readManifest, thresholdPinFailure, writeManifest } from "../judge/cassette-manifest.ts";
import { judgeFromEnv } from "../judge/client.ts";
import { Semaphore } from "../judge/semaphore.ts";
import { round4 } from "../util.ts";
import {
  type Channel,
  type CorpusPin,
  type EvalCase,
  type Floors,
  redactCitations,
  type SuiteConfig,
} from "./suite.ts";

/** Corpus clones may take longer than a skill call; give them two minutes. */
const CORPUS_CLONE_TIMEOUT_SECONDS = 120;

export type EvalMode = "replay" | "record" | "live" | "auto";

export type EvalOptions = {
  settings: JudgeSettings;
  /** The suggest bar; the suite's, else the default. */
  suggestThreshold: number;
  mode: EvalMode | null;
  sweep: number[];
  jobs: number;
  /** Stop starting cases once the run's estimated cost passes this. */
  maxCostUsd: number | null;
  /** Override every suite's corpus with one checkout. */
  rootOverride: string | undefined;
  onProgress?: (line: string) => void;
};

export type SuggestScore = {
  expected: string[];
  unknown_expected: string[];
  proposed: string[];
  found: string[];
  missed: Array<{ pack: string; score: number | null }>;
  recall: number | null;
  correct_negative: boolean | null;
};

export type CaseResult = {
  id: string;
  tags: string[];
  channels: Channel[];
  suite: string;
  /** PASS: every expectation held. FAIL: a miss, a false hit, or a near miss surfaced. SKIP: not run (cost cap). */
  result: "PASS" | "FAIL" | "SKIP";
  /** Recall for a positive case, 1 or 0 for a negative one, the mean when both channels ran. */
  score: number | null;
  find: CaseScore | null;
  suggest: SuggestScore | null;
  /** Near-miss items that surfaced anyway. */
  near_miss_hits: string[];
  note: string | null;
  notes: string[];
  wall_ms: number;
  requests: number;
  input_tokens: number;
  estimated_usd: number;
};

export type SuggestAggregate = {
  cases: number;
  positive_cases: number;
  negative_cases: number;
  macro_recall: number | null;
  negatives_correct: number | null;
  labeling_errors: number;
};

export type EvalReport = {
  schema_version: 1;
  mode: "eval";
  root: string;
  cassette_mode: CassetteMode;
  threshold: number;
  suggest_threshold: number;
  cases: CaseResult[];
  passed: number;
  failed: number;
  skipped: number;
  find: Aggregate | null;
  suggest: SuggestAggregate | null;
  /** Share of near-miss items that stayed below the bar, over every case that names one. */
  near_miss_correct: number | null;
  /** Per cassette directory: why its replay cannot be trusted at these thresholds (a gate failure). */
  pin_failures: string[];
  f05: number | null;
  sweep: Aggregate[];
  floors: Floors;
  floor_failures: string[];
  latency_ms: ReturnType<typeof latencyStats>;
  cost: { total_usd: number; mean_usd: number; requests: number; input_tokens: number };
  cost_cap: { limit_usd: number | null; reached: boolean };
  corpora: Array<{ key: string; root: string; solutions: number; pack_rules: number }>;
  model: string | null;
  warnings: string[];
};

type ResolvedCorpus = {
  key: string;
  workspace: Workspace;
  corpus: CorpusLoad;
  corpusPaths: Set<string>;
};

function corpusKey(pin: CorpusPin, rootOverride: string | undefined): string {
  if (rootOverride !== undefined) return `root:${resolve(rootOverride)}`;
  if (pin.git) return `${pin.git}@${pin.ref}${pin.docs_root ? `#${pin.docs_root}` : ""}`;
  return `path:${pin.path}${pin.docs_root ? `#${pin.docs_root}` : ""}`;
}

/**
 * A pinned corpus becomes a workspace with the checkout's own CE config, so its
 * declared packs are in play, and nothing else: no known pack source is
 * consulted, so a run is reproducible from cassettes.
 */
function resolveCorpus(
  pin: CorpusPin,
  key: string,
  ctx: Context,
  git: GitCache,
  rootOverride: string | undefined,
  warnings: Set<string>,
): ResolvedCorpus {
  let repoRoot: string;
  if (rootOverride !== undefined) {
    repoRoot = resolve(ctx.cwd, rootOverride);
  } else if (pin.git) {
    const cloneWarnings: string[] = [];
    const dir = git.clone(
      pin.git,
      pin.ref as string,
      `corpus ${pin.git}@${pin.ref}`,
      cloneWarnings,
    );
    if (!dir) throw new MissingCorpusError(`${pin.git}@${pin.ref}`, cloneWarnings);
    repoRoot = dir;
  } else if (pin.path) {
    repoRoot = pin.path;
    if (!existsSync(repoRoot)) throw new MissingCorpusError(pin.path);
  } else {
    throw new UsageError("a corpus pin needs git and ref, or path");
  }
  let config: CeConfig = loadCeConfig(repoRoot);
  if (pin.docs_root !== undefined) {
    config = {
      ...config,
      docsRoot: pin.docs_root,
      docsRootAbs: resolve(repoRoot, pin.docs_root),
      docsRootSource: "default",
    };
  }
  const workspace: Workspace = { repoRoot, config, git };
  const corpus = loadCorpus(workspace);
  for (const warning of corpus.warnings) warnings.add(warning);
  return {
    key,
    workspace,
    corpus,
    corpusPaths: new Set([
      ...corpus.learnings.candidates.map((c) => c.path),
      ...corpus.packRules.candidates.map((c) => c.path),
    ]),
  };
}

/** Which cassette mode a run uses when none was asked for: replay without a key, auto with one, live without cassettes. */
export function defaultMode(suites: SuiteConfig[], ctx: Context): EvalMode {
  const anyCassettes = suites.some((s) => s.cassettes !== null);
  if (!anyCassettes) return "live";
  return hasApiKey(ctx.env) ? "auto" : "replay";
}

function judgeEnv(ctx: Context, suite: SuiteConfig, mode: EvalMode): Context["env"] {
  const env = { ...ctx.env };
  if (mode === "live" || suite.cassettes === null) {
    delete env[CASSETTE_MODE_VARIABLE];
    delete env[CASSETTE_DIR_VARIABLE];
    return env;
  }
  env[CASSETTE_MODE_VARIABLE] = mode;
  env[CASSETTE_DIR_VARIABLE] = suite.cassettes;
  return env;
}

export async function runEval(
  root: string,
  cases: EvalCase[],
  suites: SuiteConfig[],
  options: EvalOptions,
  ctx: Context,
): Promise<EvalReport> {
  const mode = options.mode ?? defaultMode(suites, ctx);
  const warnings = new Set<string>();
  const git = createGitCache(ctx.env, { defaultTimeoutSeconds: CORPUS_CLONE_TIMEOUT_SECONDS });
  const corpora = new Map<string, ResolvedCorpus>();
  const scratch = mkdtempSync(join(tmpdir(), "compound-eval-"));
  // The key check comes before any corpus read: a live or recording run without a key
  // is exit 3, and a replay needs none.
  const suitesInPlay = [...new Set(cases.map((c) => c.suite))];
  for (const suite of suitesInPlay) {
    judgeFromEnv(judgeEnv(ctx, suite, mode), { model: options.settings.model });
  }
  // Recorded answers do not depend on the threshold; the manifest beside the cassettes
  // pins what they were scored at, and a replay at another bar is a gate failure.
  const pinFailures: string[] = [];
  const cassetteDirs = new Map<string, ReturnType<typeof readManifest>>();
  if (mode !== "live") {
    for (const suite of suitesInPlay) {
      if (suite.cassettes === null || cassetteDirs.has(suite.cassettes)) continue;
      const manifest = readManifest(suite.cassettes);
      cassetteDirs.set(suite.cassettes, manifest);
      const failure = thresholdPinFailure(
        manifest,
        mode,
        options.settings.threshold,
        options.suggestThreshold,
      );
      if (failure) pinFailures.push(`${suite.name}: ${failure}`);
    }
  }
  try {
    for (const evalCase of cases) {
      const pin = evalCase.suite.corpus as CorpusPin;
      const key = corpusKey(pin, options.rootOverride);
      if (!corpora.has(key)) {
        corpora.set(key, resolveCorpus(pin, key, ctx, git, options.rootOverride, warnings));
      }
    }

    const gate = new Semaphore(options.jobs);
    const requests = new Semaphore(options.settings.parallel);
    const stop = new AbortController();
    const total = { requests: 0, input_tokens: 0, estimated_usd: 0, model: null as string | null };
    const results: CaseResult[] = [];
    let capReached = false;

    await Promise.all(
      cases.map((evalCase, index) =>
        gate.run(async () => {
          if (stop.signal.aborted) return;
          if (options.maxCostUsd !== null && total.estimated_usd >= options.maxCostUsd) {
            capReached = true;
            results[index] = skipped(evalCase, "cost cap reached before this case started");
            return;
          }
          const resolved = corpora.get(
            corpusKey(evalCase.suite.corpus as CorpusPin, options.rootOverride),
          );
          if (!resolved) throw new Error(`corpus for ${evalCase.id} was not resolved`);
          const judge = judgeFromEnv(judgeEnv(ctx, evalCase.suite, mode), {
            model: options.settings.model,
            parallel: options.settings.parallel,
            requests,
          });
          const started = performance.now();
          let result: CaseResult;
          try {
            result = await runCase(evalCase, resolved, judge, options, ctx, scratch);
          } catch (error) {
            stop.abort(error);
            if (error instanceof CliError) {
              throw new CliError(`case "${evalCase.id}": ${error.message}`, error.exitCode, {
                cause: error,
              });
            }
            throw error;
          }
          const usage = judge.usage.snapshot();
          result.wall_ms = Math.round(performance.now() - started);
          result.requests = usage.requests;
          result.input_tokens = usage.input_tokens;
          result.estimated_usd = usage.estimated_usd;
          results[index] = result;
          total.requests += usage.requests;
          total.input_tokens += usage.input_tokens;
          total.estimated_usd += usage.estimated_usd;
          total.model = usage.model ?? total.model;
          options.onProgress?.(progressLine(result));
        }, stop.signal),
      ),
    );

    const ran = results.filter((r) => r && r.result !== "SKIP");
    const byId = new Map(cases.map((c) => [c.id, c]));
    // Near misses are scored on their own: they never count as clear negatives.
    const clear = ran.filter((r) => !byId.get(r.id)?.nearMiss);
    const findScores = clear.flatMap((r) => (r.find ? [r.find] : []));
    const suggestScores = clear.flatMap((r) => (r.suggest ? [r.suggest] : []));
    const findAggregate = findScores.length
      ? aggregate(findScores, options.settings.threshold)
      : null;
    const suggestAggregate = suggestScores.length ? aggregateSuggest(suggestScores) : null;
    const nearMissCases = ran.filter((r) => byId.get(r.id)?.nearMiss);
    const nearMissCorrect = nearMissCases.length
      ? round4(nearMissCases.filter((r) => r.result === "PASS").length / nearMissCases.length)
      : null;
    const floors = mergedFloors(suites, cases);
    const failures = [
      ...evalFloorFailures(findAggregate, suggestAggregate, nearMissCorrect, floors),
      ...pinFailures.map((f) => `cassette pin: ${f}`),
    ];
    for (const failure of pinFailures) {
      warnings.add(
        `${failure} (recordings do not depend on the threshold, so the floor may not mean what it did)`,
      );
    }
    // A recording leaves a pin behind; auto pins only a fresh directory, never rewriting one.
    if (mode === "record" || mode === "auto") {
      for (const [dir, manifest] of cassetteDirs) {
        if (mode === "auto" && manifest !== undefined) continue;
        writeManifest(dir, {
          recorded_at: new Date().toISOString(),
          threshold: options.settings.threshold,
          tier_one_threshold: options.settings.tierOneThreshold,
          suggest_threshold: options.suggestThreshold,
          model_requested: options.settings.model,
          model_answered: total.model,
        });
      }
    }
    const usd = Number(total.estimated_usd.toFixed(8));
    return {
      schema_version: 1,
      mode: "eval",
      root: resolve(root),
      cassette_mode: mode === "live" ? "off" : mode,
      threshold: options.settings.threshold,
      suggest_threshold: options.suggestThreshold,
      cases: results,
      passed: ran.filter((r) => r.result === "PASS").length,
      failed: ran.filter((r) => r.result === "FAIL").length,
      skipped: results.filter((r) => r?.result === "SKIP").length,
      find: findAggregate,
      suggest: suggestAggregate,
      near_miss_correct: nearMissCorrect,
      pin_failures: pinFailures,
      f05: findAggregate
        ? fBeta(findAggregate.precision_lower_bound, findAggregate.micro_recall)
        : null,
      sweep: options.sweep.map((t) =>
        aggregate(
          clear.flatMap((r) => (r.find ? [rescore(r, t)] : [])),
          t,
        ),
      ),
      floors,
      floor_failures: failures,
      latency_ms: latencyStats(ran.map((r) => r.wall_ms)),
      cost: {
        total_usd: usd,
        mean_usd: ran.length ? Number((usd / ran.length).toFixed(8)) : 0,
        requests: total.requests,
        input_tokens: total.input_tokens,
      },
      cost_cap: { limit_usd: options.maxCostUsd, reached: capReached },
      corpora: [...corpora.values()].map((c) => ({
        key: c.key,
        root: c.workspace.repoRoot,
        solutions: c.corpus.learnings.candidates.length,
        pack_rules: c.corpus.packRules.candidates.length,
      })),
      model: total.model,
      warnings: [...warnings],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The find rerun a sweep needs: the same judgments, another threshold. */
const RUNS = new WeakMap<CaseResult, CaseRun>();

function rescore(result: CaseResult, threshold: number): CaseScore {
  const run = RUNS.get(result);
  return run ? scoreCase(run, threshold) : (result.find as CaseScore);
}

function skipped(evalCase: EvalCase, reason: string): CaseResult {
  return {
    id: evalCase.id,
    tags: evalCase.tags,
    channels: evalCase.channels,
    suite: evalCase.suite.name,
    result: "SKIP",
    score: null,
    find: null,
    suggest: null,
    near_miss_hits: [],
    note: evalCase.note ?? null,
    notes: [reason],
    wall_ms: 0,
    requests: 0,
    input_tokens: 0,
    estimated_usd: 0,
  };
}

async function runCase(
  evalCase: EvalCase,
  resolved: ResolvedCorpus,
  judge: ReturnType<typeof judgeFromEnv>,
  options: EvalOptions,
  ctx: Context,
  scratch: string,
): Promise<CaseResult> {
  const { workspace, corpus } = resolved;
  const q = evalCase.query;
  let planPath: string | undefined;
  if (q.plan !== undefined) {
    const source = resolve(workspace.repoRoot, q.plan);
    if (!existsSync(source)) {
      throw new UsageError(`${evalCase.id}: plan ${q.plan} is not in the corpus at its pinned ref`);
    }
    if (q.redact_citations) {
      // The judge reads a copy with the citation lines dropped; the copy keeps the
      // plan's file name so a title derived from it is the same as the original's.
      const copyDir = mkdtempSync(join(scratch, "plan-"));
      planPath = join(copyDir, basename(source));
      writeFileSync(planPath, redactCitations(readFileSync(source, "utf8")));
    } else {
      planPath = source;
    }
  }
  const state = await buildWorkState(
    {
      activity: q.activity,
      concepts: q.concepts,
      decisions: q.decisions,
      domains: q.domains,
      modules: q.modules,
      paths: q.paths,
      diffPath: q.diff === undefined ? undefined : resolve(evalCase.dir, q.diff),
      planPath,
      docPath: undefined,
    },
    ctx,
  );

  const result: CaseResult = {
    id: evalCase.id,
    tags: evalCase.tags,
    channels: evalCase.channels,
    suite: evalCase.suite.name,
    result: "PASS",
    score: null,
    find: null,
    suggest: null,
    near_miss_hits: [],
    note: evalCase.note ?? null,
    notes: [],
    wall_ms: 0,
    requests: 0,
    input_tokens: 0,
    estimated_usd: 0,
  };
  const scores: number[] = [];
  const nearMissPaths = evalCase.expect.near_miss.filter((n) => n.includes("/"));
  const nearMissPacks = evalCase.expect.near_miss.filter((n) => !n.includes("/"));

  if (evalCase.channels.includes("find")) {
    const kinds = evalCase.suite.kinds ?? [];
    const run = await runFind({
      workspace,
      state,
      judge,
      settings: options.settings,
      filters: { ...NO_FILTERS, kinds },
      mode: "find",
      corpus,
    });
    // Corpus-level warnings are the report's; a case notes only what its own run added.
    for (const w of run.result.warnings) {
      if (!corpus.warnings.includes(w)) result.notes.push(w);
    }
    const negative = evalCase.expect.nothing_relevant || evalCase.expect.hits.length === 0;
    const caseRun: CaseRun = {
      benchCase: { id: evalCase.id, query: {}, expected: evalCase.expect.hits, negative },
      run,
      corpusPaths: resolved.corpusPaths,
      wall_ms: 0,
      requests: 0,
      input_tokens: 0,
      estimated_usd: 0,
    };
    RUNS.set(result, caseRun);
    const score = scoreCase(caseRun, options.settings.threshold);
    result.find = score;
    if (score.unknown_expected.length) {
      result.notes.push(`not in the corpus: ${score.unknown_expected.join(", ")}`);
    }
    if (negative) {
      scores.push(score.correct_negative ? 1 : 0);
      if (!score.correct_negative) result.notes.push(`false hit: ${score.hits.join(", ")}`);
    } else if (score.recall !== null) {
      scores.push(score.recall);
      if (score.recall < 1) {
        result.notes.push(
          `missed ${score.missed
            .map((m) => `${basename(m.path)} (score ${m.score ?? "-"}, rank ${m.rank ?? "-"})`)
            .join(", ")}`,
        );
      }
    }
    for (const path of nearMissPaths) {
      if (score.hits.includes(path)) result.near_miss_hits.push(path);
    }
    // A near-miss pack id also names its rules on the find channel; an adversarial
    // negative counts anything that surfaced.
    for (const hit of score.hits) {
      const inNamedPack = nearMissPacks.some((pack) => hit.startsWith(`${pack}/`));
      if ((inNamedPack || evalCase.nearMiss) && !result.near_miss_hits.includes(hit)) {
        result.near_miss_hits.push(hit);
      }
    }
  }

  if (evalCase.channels.includes("suggest")) {
    const sourceDir = resolve(workspace.repoRoot, evalCase.suite.packs_source ?? "packs");
    if (!existsSync(sourceDir)) {
      throw new UsageError(
        `${evalCase.id}: the suite has no packs_source directory at ${sourceDir}; a suggest case needs one`,
      );
    }
    // A consumer that declares nothing and knows only this source: what a repository
    // adopting these packs would be offered.
    const load = loadPackCandidatesFrom(
      [{ label: evalCase.suite.file, kind: "local", source: sourceDir }],
      workspace.repoRoot,
      new Set(),
      ctx.env,
      "cached-only",
    );
    for (const w of load.warnings) result.notes.push(w);
    const work = judgeState(state);
    const judged = await judgePackCandidates(judge, work, load.candidates, options.settings.batch);
    const known = new Set(load.candidates.map((c) => c.packId ?? c.path));
    const byPack = new Map<string, number>();
    for (const candidate of load.candidates) {
      byPack.set(candidate.packId ?? candidate.path, judged.get(candidate) ?? 0);
    }
    const proposed = [...byPack.entries()]
      .filter(([, score]) => score >= options.suggestThreshold)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    const expected = evalCase.expect.packs.filter((p) => known.has(p));
    const unknown = evalCase.expect.packs.filter((p) => !known.has(p));
    const negative = evalCase.expect.nothing_relevant || evalCase.expect.packs.length === 0;
    const found = expected.filter((p) => proposed.includes(p));
    const suggest: SuggestScore = {
      expected: evalCase.expect.packs,
      unknown_expected: unknown,
      proposed,
      found,
      missed: expected
        .filter((p) => !proposed.includes(p))
        .map((pack) => ({
          pack,
          score: byPack.has(pack) ? round4(byPack.get(pack) as number) : null,
        })),
      recall: negative || expected.length === 0 ? null : found.length / expected.length,
      correct_negative: negative ? proposed.length === 0 : null,
    };
    result.suggest = suggest;
    if (unknown.length) result.notes.push(`not a pack in the source: ${unknown.join(", ")}`);
    if (negative) {
      scores.push(suggest.correct_negative ? 1 : 0);
      if (!suggest.correct_negative) result.notes.push(`false suggestion: ${proposed.join(", ")}`);
    } else if (suggest.recall !== null) {
      scores.push(suggest.recall);
      if (suggest.recall < 1) {
        result.notes.push(
          `not suggested: ${suggest.missed.map((m) => `${m.pack} (${m.score ?? "-"})`).join(", ")}`,
        );
      }
    }
    for (const pack of proposed) {
      if (
        (nearMissPacks.includes(pack) || evalCase.nearMiss) &&
        !result.near_miss_hits.includes(pack)
      ) {
        result.near_miss_hits.push(pack);
      }
    }
  }

  if (result.near_miss_hits.length) {
    result.notes = result.notes.filter((n) => !n.startsWith("false "));
    result.notes.push(`near miss surfaced: ${result.near_miss_hits.join(", ")}`);
  }
  result.score = scores.length ? round4(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const labelingError =
    (result.find?.unknown_expected.length ?? 0) > 0 ||
    (result.suggest?.unknown_expected.length ?? 0) > 0;
  result.result =
    result.score === 1 && !result.near_miss_hits.length && !labelingError ? "PASS" : "FAIL";
  return result;
}

function aggregateSuggest(scores: SuggestScore[]): SuggestAggregate {
  const positives = scores.filter((s) => s.recall !== null);
  const negatives = scores.filter((s) => s.correct_negative !== null);
  return {
    cases: scores.length,
    positive_cases: positives.length,
    negative_cases: negatives.length,
    macro_recall: positives.length
      ? round4(positives.reduce((a, s) => a + (s.recall as number), 0) / positives.length)
      : null,
    negatives_correct: negatives.length
      ? round4(negatives.filter((s) => s.correct_negative).length / negatives.length)
      : null,
    labeling_errors: scores.reduce((n, s) => n + s.unknown_expected.length, 0),
  };
}

/** Every suite's floors, merged; a floor named twice with different values keeps the stricter. */
function mergedFloors(suites: SuiteConfig[], cases: EvalCase[]): Floors {
  const floors: Floors = {};
  const used = new Set(cases.map((c) => c.suite));
  for (const suite of [...suites, ...used]) {
    for (const [key, value] of Object.entries(suite.floors) as Array<[keyof Floors, number]>) {
      const current = floors[key];
      if (current === undefined || value > current) floors[key] = value;
    }
  }
  return floors;
}

function evalFloorFailures(
  find: Aggregate | null,
  suggest: SuggestAggregate | null,
  nearMissCorrect: number | null,
  floors: Floors,
): string[] {
  const failures: string[] = [];
  if (find) {
    const { suggest_macro_recall: _s, near_miss_correct: _n, ...findFloors } = floors;
    failures.push(...floorFailures(find, findFloors));
  }
  if (suggest) {
    if (floors.suggest_macro_recall !== undefined) {
      const value = suggest.macro_recall ?? 0;
      if (value < floors.suggest_macro_recall) {
        failures.push(
          `suggest macro recall ${value} is below the floor ${floors.suggest_macro_recall}`,
        );
      }
    }
    if (floors.negatives_correct !== undefined && suggest.negatives_correct !== null) {
      if (suggest.negatives_correct < floors.negatives_correct) {
        failures.push(
          `suggest negatives correct ${suggest.negatives_correct} is below the floor ${floors.negatives_correct}`,
        );
      }
    }
    if (suggest.labeling_errors > 0) {
      failures.push(
        `${suggest.labeling_errors} expected pack(s) are not in the source (labeling errors fail the gate)`,
      );
    }
  }
  if (floors.near_miss_correct !== undefined && nearMissCorrect !== null) {
    if (nearMissCorrect < floors.near_miss_correct) {
      failures.push(
        `near miss correct ${nearMissCorrect} is below the floor ${floors.near_miss_correct}`,
      );
    }
  }
  return failures;
}

function progressLine(result: CaseResult): string {
  const detail = result.notes.length ? `  ${result.notes[0]}` : "";
  return `${result.id.padEnd(48)} ${result.result.padEnd(4)} ${result.score === null ? "-" : result.score.toFixed(2)}  ${result.wall_ms} ms, $${result.estimated_usd.toFixed(5)}${detail}`;
}
