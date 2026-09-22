import type { FindRun } from "../find/result.ts";
import { round4 } from "../util.ts";
import type { BenchCase } from "./cases.ts";

export type CaseRun = {
  benchCase: BenchCase;
  run: FindRun;
  /** Every path the corpus loaded, so a labeling error means "not in the corpus", never "not judged". */
  corpusPaths: ReadonlySet<string>;
  wall_ms: number;
  requests: number;
  input_tokens: number;
  estimated_usd: number;
};

export type CaseScore = {
  id: string;
  negative: boolean;
  expected: string[];
  /** Expected paths that are not in the corpus at all: a labeling error, not a miss. */
  unknown_expected: string[];
  hits: string[];
  found: string[];
  missed: Array<{
    path: string;
    score: number | null;
    tier_one_score: number;
    rank: number | null;
  }>;
  recall: number | null;
  precision_lower_bound: number | null;
  correct_negative: boolean | null;
  wall_ms: number;
  requests: number;
  input_tokens: number;
  estimated_usd: number;
};

export type Floors = {
  macro_recall?: number;
  negatives_correct?: number;
  precision_lower_bound?: number;
};

/** Every floor the aggregate fails, as "name value < floor" lines. */
export function floorFailures(aggregate: Aggregate, floors: Floors): string[] {
  const failures: string[] = [];
  for (const key of ["macro_recall", "negatives_correct", "precision_lower_bound"] as const) {
    const floor = floors[key];
    if (floor === undefined) continue;
    const value = aggregate[key] ?? 0;
    if (value < floor)
      failures.push(`${key.replaceAll("_", " ")} ${value} is below the floor ${floor}`);
  }
  if (aggregate.labeling_errors > 0) {
    failures.push(
      `${aggregate.labeling_errors} expected path(s) are not in the corpus (labeling errors fail the gate)`,
    );
  }
  return failures;
}

export type Aggregate = {
  threshold: number;
  cases: number;
  positive_cases: number;
  negative_cases: number;
  macro_recall: number | null;
  micro_recall: number | null;
  precision_lower_bound: number | null;
  negatives_correct: number | null;
  perfect_cases: number;
  labeling_errors: number;
};

export type BenchReport = {
  schema_version: 1;
  name: string;
  threshold: number;
  aggregate: Aggregate;
  /** F0.5 at the operating threshold. */
  f05: number | null;
  recall_at_precision_floor: FlooredRecall | null;
  sweep: Aggregate[];
  cases: CaseScore[];
  latency_ms: { median: number; p90: number; mean: number; total: number };
  cost: { total_usd: number; mean_usd: number; requests: number; input_tokens: number };
  corpus: { root: string; solutions: number; pack_rules: number };
  model: string | null;
  cassette_mode: string;
  warnings: string[];
};

/** Score one case at a threshold from the judgments already made. */
export function scoreCase(caseRun: CaseRun, threshold: number): CaseScore {
  const { benchCase, run } = caseRun;
  const unknown = benchCase.expected.filter((p) => !caseRun.corpusPaths.has(p));
  const expected = benchCase.expected.filter((p) => caseRun.corpusPaths.has(p));
  const ranked = [...run.scored].sort((a, b) => effective(b) - effective(a));
  const hits = ranked
    .filter((s) => s.score !== null && s.score >= threshold)
    .map((s) => s.candidate.path);
  const hitSet = new Set(hits);
  const found = expected.filter((p) => hitSet.has(p));
  const missed = expected
    .filter((p) => !hitSet.has(p))
    .map((path) => {
      const index = ranked.findIndex((s) => s.candidate.path === path);
      const entry = ranked[index];
      return {
        path,
        score: entry?.score ?? null,
        tier_one_score: entry?.tierOneScore ?? 0,
        rank: index === -1 ? null : index + 1,
      };
    });
  const negative = Boolean(benchCase.negative);
  return {
    id: benchCase.id,
    negative,
    expected: benchCase.expected,
    unknown_expected: unknown,
    hits,
    found,
    missed,
    recall: negative || expected.length === 0 ? null : found.length / expected.length,
    precision_lower_bound: negative || hits.length === 0 ? null : found.length / hits.length,
    correct_negative: negative ? hits.length === 0 : null,
    wall_ms: caseRun.wall_ms,
    requests: caseRun.requests,
    input_tokens: caseRun.input_tokens,
    estimated_usd: caseRun.estimated_usd,
  };
}

export function aggregate(scores: CaseScore[], threshold: number): Aggregate {
  const positives = scores.filter((s) => !s.negative && s.recall !== null);
  const negatives = scores.filter((s) => s.negative);
  const totalExpected = positives.reduce(
    (n, s) => n + s.expected.length - s.unknown_expected.length,
    0,
  );
  const totalFound = positives.reduce((n, s) => n + s.found.length, 0);
  const totalHits = positives.reduce((n, s) => n + s.hits.length, 0);
  const negativesCorrect = negatives.filter((s) => s.correct_negative).length;
  return {
    threshold,
    cases: scores.length,
    positive_cases: positives.length,
    negative_cases: negatives.length,
    macro_recall: positives.length
      ? round4(positives.reduce((n, s) => n + (s.recall ?? 0), 0) / positives.length)
      : null,
    micro_recall: totalExpected ? round4(totalFound / totalExpected) : null,
    precision_lower_bound: totalHits ? round4(totalFound / totalHits) : null,
    negatives_correct: negatives.length ? round4(negativesCorrect / negatives.length) : null,
    perfect_cases: positives.filter((s) => s.recall === 1).length + negativesCorrect,
    labeling_errors: scores.reduce((n, s) => n + s.unknown_expected.length, 0),
  };
}

/** F-beta with beta 0.5: precision weighs more than recall, so a degenerate low threshold scores badly. */
export function fBeta(precision: number | null, recall: number | null, beta = 0.5): number | null {
  if (precision === null || recall === null) return null;
  if (precision === 0 && recall === 0) return 0;
  const b2 = beta * beta;
  return round4(((1 + b2) * precision * recall) / (b2 * precision + recall));
}

export type FlooredRecall = {
  precision_floor: number;
  /** The best micro recall among thresholds whose precision lower bound meets the floor, or null when none does. */
  recall: number | null;
  macro_recall: number | null;
  threshold: number | null;
  precision_lower_bound: number | null;
  negatives_correct: number | null;
  f05: number | null;
};

/**
 * Recall at a precision floor: sweep thresholds over the recorded judgments and
 * take the highest recall whose precision lower bound stays at or above the
 * floor. Lowering the threshold cannot win this metric by itself.
 */
export function recallAtPrecisionFloor(runs: CaseRun[], floor: number): FlooredRecall {
  let best: FlooredRecall = {
    precision_floor: floor,
    recall: null,
    macro_recall: null,
    threshold: null,
    precision_lower_bound: null,
    negatives_correct: null,
    f05: null,
  };
  for (let i = 5; i <= 95; i += 5) {
    const threshold = i / 100;
    const agg = aggregate(
      runs.map((r) => scoreCase(r, threshold)),
      threshold,
    );
    const precision = agg.precision_lower_bound ?? 0;
    const recall = agg.micro_recall ?? 0;
    if (precision < floor) continue;
    // Ties resolve to the highest threshold: same recall, fewer unlabeled hits.
    if (best.recall === null || recall >= best.recall) {
      best = {
        precision_floor: floor,
        recall,
        macro_recall: agg.macro_recall,
        threshold,
        precision_lower_bound: agg.precision_lower_bound,
        negatives_correct: agg.negatives_correct,
        f05: fBeta(agg.precision_lower_bound, agg.micro_recall),
      };
    }
  }
  return best;
}

export function latencyStats(values: number[]): BenchReport["latency_ms"] {
  if (values.length === 0) return { median: 0, p90: 0, mean: 0, total: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank percentile: the smallest value at or above the requested share of samples.
  const at = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const total = sorted.reduce((a, b) => a + b, 0);
  return { median: at(0.5), p90: at(0.9), mean: Math.round(total / sorted.length), total };
}

function effective(entry: FindRun["scored"][number]): number {
  return entry.score ?? entry.tierOneScore;
}
