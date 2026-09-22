import type { Candidate } from "../corpus/candidate.ts";
import type { Workspace } from "../corpus/load.ts";
import { loadCorpus } from "../corpus/load.ts";
import { MissingCorpusError } from "../errors.ts";
import { judgeState, type WorkState } from "../input/work-state.ts";
import type { Judge } from "../judge/client.ts";
import type { JudgeWork } from "../judge/questions.ts";
import { applyFilters, type CandidateFilters } from "./filters.ts";
import { judgeOverlap } from "./overlap.ts";
import { prefilter } from "./prefilter.ts";
import type { FindMode, FindRun, Hit, ScoredCandidate } from "./result.ts";
import { SCHEMA_VERSION } from "./result.ts";
import { judgePackCandidates, judgeTierOne } from "./tier-one.ts";
import { judgeTierTwo } from "./tier-two.ts";

export type JudgeSettings = {
  threshold: number;
  tierOneThreshold: number;
  frontmatterOnly: boolean;
  batch: number;
  parallel: number;
  candidateCap: number;
  excerptChars: number;
  model: string;
};

export type PackCandidateLoader = (workspace: Workspace) => {
  candidates: Candidate[];
  warnings: string[];
};

export type FindInput = {
  workspace: Workspace;
  state: WorkState;
  judge: Judge;
  settings: JudgeSettings;
  filters: CandidateFilters;
  mode: FindMode;
  /** Known-source pack candidates (plan R25); omitted or `--no-sources` means none. */
  loadPackCandidates?: PackCandidateLoader;
};

export async function runFind(input: FindInput): Promise<FindRun> {
  const { workspace, state, judge, settings, filters, mode } = input;
  const corpus = loadCorpus(workspace);
  const warnings = [...corpus.warnings];
  const packCandidates = input.loadPackCandidates
    ? input.loadPackCandidates(workspace)
    : { candidates: [], warnings: [] };
  warnings.push(...packCandidates.warnings);

  const all: Candidate[] = [
    ...corpus.learnings.candidates,
    ...corpus.packRules.candidates,
    ...packCandidates.candidates,
  ];
  if (
    corpus.learnings.candidates.length === 0 &&
    corpus.packRules.candidates.length === 0 &&
    corpus.packs.roots.length === 0
  ) {
    if (!corpus.learnings.exists) throw new MissingCorpusError(workspace.config.docsRoot);
  }

  const { kept, filteredOut } = applyFilters(all, filters);
  if (kept.length === 0 && all.length > 0)
    warnings.push("every candidate was removed by the filters");
  const filtered = prefilter(kept, state.keywords, settings.candidateCap);
  const work: JudgeWork = judgeState(state);

  const learningsAndRules = filtered.ordered.filter((c) => c.kind !== "pack_candidate");
  const packs = filtered.ordered.filter((c) => c.kind === "pack_candidate");
  const [tierOne, packScores] = await Promise.all([
    judgeTierOne(judge, work, learningsAndRules, { batch: settings.batch }),
    judgePackCandidates(judge, work, packs, settings.batch),
  ]);

  const scored: ScoredCandidate[] = filtered.ordered.map((candidate) => ({
    candidate,
    tierOneScore: tierOne.get(candidate) ?? packScores.get(candidate) ?? 0,
    score: null,
    passage: null,
    matchedFields: filtered.scores.get(candidate)?.matchedFields ?? [],
    overlap: null,
  }));

  // Pack READMEs are the whole judgment: their tier-one score is final.
  for (const entry of scored)
    if (entry.candidate.kind === "pack_candidate") entry.score = entry.tierOneScore;

  const passing = scored.filter(
    (entry) =>
      entry.candidate.kind !== "pack_candidate" && entry.tierOneScore >= settings.tierOneThreshold,
  );
  let tierTwoJudged = 0;
  if (mode === "overlap") {
    if (!state.doc) throw new Error("overlap mode requires a draft document");
    const overlap = await judgeOverlap(
      judge,
      state.doc,
      passing.map((e) => e.candidate),
      settings.excerptChars,
    );
    for (const entry of passing) {
      const scores = overlap.get(entry.candidate);
      if (scores) {
        entry.overlap = scores;
        entry.score = scores.overall;
      }
    }
    tierTwoJudged = passing.length;
  } else if (settings.frontmatterOnly) {
    for (const entry of scored) entry.score = entry.tierOneScore;
  } else {
    const tierTwo = await judgeTierTwo(
      judge,
      work,
      passing.map((e) => e.candidate),
      { excerptChars: settings.excerptChars },
    );
    for (const entry of passing) {
      const answer = tierTwo.get(entry.candidate);
      if (answer) {
        entry.score = answer.score;
        entry.passage = answer.passage;
      }
    }
    tierTwoJudged = passing.length;
  }

  const hits = buildHits(scored, settings.threshold);
  const bestScore = Math.max(0, ...scored.map((e) => e.score ?? e.tierOneScore));
  const run: FindRun = {
    scored,
    result: {
      schema_version: SCHEMA_VERSION,
      mode,
      state,
      hits,
      nothing_relevant: hits.length === 0,
      threshold: settings.threshold,
      tier_one_threshold: settings.tierOneThreshold,
      frontmatter_only: settings.frontmatterOnly,
      gate:
        mode === "gate"
          ? { probability: round(bestScore), threshold: settings.threshold, hits: hits.length }
          : null,
      usage: judge.usage.snapshot(),
      corpus: {
        solutions: corpus.learnings.candidates.length,
        pack_rules: corpus.packRules.candidates.length,
        pack_candidates: packCandidates.candidates.length,
        judged: filtered.ordered.length,
        tier_two_judged: tierTwoJudged,
        prefilter_dropped: filtered.dropped,
        filtered_out: filteredOut,
      },
      warnings,
    },
  };
  return run;
}

/** Hits are the scored candidates at or above the threshold, strongest first. */
export function buildHits(scored: ScoredCandidate[], threshold: number): Hit[] {
  return scored
    .filter((entry) => entry.score !== null && entry.score >= threshold)
    .sort(
      (a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        b.tierOneScore - a.tierOneScore ||
        a.candidate.path.localeCompare(b.candidate.path),
    )
    .map((entry) => toHit(entry));
}

function toHit(entry: ScoredCandidate): Hit {
  const c = entry.candidate;
  return {
    path: c.path,
    kind: c.kind,
    score: round(entry.score ?? entry.tierOneScore),
    tier_one_score: round(entry.tierOneScore),
    pack_id: c.packId ?? null,
    pack_path: c.packPath ?? null,
    title: c.title,
    frontmatter: c.frontmatter,
    passage: entry.passage,
    matched_fields: entry.matchedFields,
    declaration: c.declaration ?? null,
    overlap: entry.overlap,
  };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
