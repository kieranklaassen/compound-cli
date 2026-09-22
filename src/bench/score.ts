import type { FindRun } from "../find/result.ts";
import { round4 } from "../util.ts";
import type { BenchCase } from "./cases.ts";

export type CaseRun = {
  benchCase: BenchCase;
  run: FindRun;
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
  const scoredPaths = new Set(run.scored.map((s) => s.candidate.path));
  const unknown = benchCase.expected.filter((p) => !scoredPaths.has(p));
  const expected = benchCase.expected.filter((p) => scoredPaths.has(p));
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
