import type { CeConfig } from "../config/ce-config.ts";
import type { Candidate, CandidateLoad } from "../corpus/candidate.ts";
import { type CorpusLoad, loadCorpus, type Workspace } from "../corpus/load.ts";
import type { PacksResolution } from "../corpus/packs.ts";
import { MissingCorpusError } from "../errors.ts";
import { PLAN_TEXT_CHARS } from "../input/plan.ts";
import { assertWorkFits, judgeState, type WorkState } from "../input/work-state.ts";
import type { Judge } from "../judge/client.ts";
import type { JudgeWork } from "../judge/questions.ts";
import { errorMessage, round4 } from "../util.ts";
import { DEFAULTS } from "./defaults.ts";
import { applyFilters, type CandidateFilters } from "./filters.ts";
import { judgeOverlap } from "./overlap.ts";
import { prefilter } from "./prefilter.ts";
import {
  type FindMode,
  type FindRun,
  type Hit,
  SCHEMA_VERSION,
  type ScoredCandidate,
} from "./result.ts";
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

export type PackCandidateLoader = (
  workspace: Workspace,
  declaredIds: ReadonlySet<string>,
) => CandidateLoad;

export type FindInput = {
  workspace: Workspace;
  state: WorkState;
  judge: Judge;
  settings: JudgeSettings;
  filters: CandidateFilters;
  mode: FindMode;
  /** Known-source pack candidates (plan R25); omitted or `--no-sources` means none. */
  loadPackCandidates?: PackCandidateLoader;
  /** A corpus already loaded by the caller (bench loads once for every case). */
  corpus?: CorpusLoad;
};

export async function runFind(input: FindInput): Promise<FindRun> {
  const { workspace, state, judge, settings, filters, mode } = input;
  const corpus = input.corpus ?? loadCorpus(workspace);
  const warnings = [...corpus.warnings];
  const work: JudgeWork = judgeState(state);
  assertWorkFits(work);
  // Overlap compares a draft with existing documents; a pack README is not one of those.
  const packCandidates =
    input.loadPackCandidates && mode !== "overlap"
      ? input.loadPackCandidates(workspace, declaredPackIds(workspace.config, corpus.packs))
      : { candidates: [], warnings: [] };
  warnings.push(...packCandidates.warnings);

  const all: Candidate[] = [
    ...corpus.learnings.candidates,
    ...corpus.packRules.candidates,
    ...packCandidates.candidates,
  ];
  if (all.length === 0 && !corpus.learnings.exists && corpus.packs.roots.length === 0) {
    throw new MissingCorpusError(workspace.config.docsRoot, corpus.packs.errors);
  }

  const { kept, filteredOut } = applyFilters(all, filters);
  if (kept.length === 0 && all.length > 0)
    warnings.push("every candidate was removed by the filters");
  const filtered = prefilter(kept, state.keywords, settings.candidateCap);
  if (filtered.droppedProtected > 0) {
    warnings.push(
      `corpus exceeds the candidate cap of ${settings.candidateCap}: ${filtered.droppedProtected} candidates with applies_when were cut by keyword order (raise --candidate-cap above ${settings.candidateCap}; ${filtered.droppedProtected} more would be judged)`,
    );
  }
  if (state.plan?.text_truncated) {
    warnings.push(
      `plan text was cut to ${PLAN_TEXT_CHARS} characters (the plan has ${state.plan.text_chars}); the judge read the beginning`,
    );
  }

  const learningsAndRules = filtered.ordered.filter((c) => c.kind !== "pack_candidate");
  const packs = filtered.ordered.filter((c) => c.kind === "pack_candidate");
  const [tierOne, packScores] = await Promise.all([
    judgeTierOne(judge, work, learningsAndRules, { batch: settings.batch }),
    // Pack suggestions are optional extras: their failure must not take the recall down with it.
    judgePackCandidates(judge, work, packs, settings.batch).catch((error: unknown) => {
      warnings.push(`pack candidates were not judged: ${errorMessage(error)}`);
      return new Map<Candidate, number>();
    }),
  ]);

  const scored: ScoredCandidate[] = filtered.ordered.map((candidate) => {
    const tierOneScore = tierOne.get(candidate) ?? packScores.get(candidate) ?? 0;
    return {
      candidate,
      tierOneScore,
      // Pack READMEs are the whole judgment: their tier-one score is final.
      score: candidate.kind === "pack_candidate" ? tierOneScore : null,
      passage: null,
      matchedFields: filtered.scores.get(candidate)?.matchedFields ?? [],
      overlap: null,
    };
  });

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
  // The gate is the strongest confirmed score (plan KTD10); a tier-one score that
  // never earned a body read is not confirmation, and pack suggestions live on
  // another scale, so they never move the gate.
  const bestScore = Math.max(
    0,
    ...scored.filter((e) => e.candidate.kind !== "pack_candidate").map((e) => e.score ?? 0),
  );
  const run: FindRun = {
    scored,
    result: {
      schema_version: SCHEMA_VERSION,
      mode,
      state,
      hits,
      nothing_relevant: hits.length === 0,
      threshold: settings.threshold,
      suggest_threshold: DEFAULTS.suggestThreshold,
      tier_one_threshold: settings.tierOneThreshold,
      frontmatter_only: settings.frontmatterOnly,
      gate:
        mode === "gate"
          ? { probability: round4(bestScore), threshold: settings.threshold, hits: hits.length }
          : null,
      usage: judge.usage.snapshot(),
      corpus: {
        solutions: corpus.learnings.candidates.length,
        pack_rules: corpus.packRules.candidates.length,
        pack_candidates: packCandidates.candidates.length,
        judged: filtered.ordered.length,
        tier_two_judged: tierTwoJudged,
        prefilter_dropped: filtered.dropped,
        prefilter_dropped_protected: filtered.droppedProtected,
        candidate_cap: settings.candidateCap,
        filtered_out: filteredOut,
      },
      warnings,
    },
  };
  return run;
}

/**
 * Pack ids the repo has declared, whether or not they resolved this run: a
 * declared pack whose clone failed must not come back as a suggestion.
 */
export function declaredPackIds(config: CeConfig, resolution: PacksResolution): Set<string> {
  const ids = new Set(resolution.roots.map((root) => root.id));
  for (const entry of config.packs) {
    if (entry.id) ids.add(entry.id);
    const selected =
      entry.pack === undefined ? [] : Array.isArray(entry.pack) ? entry.pack : [entry.pack];
    for (const id of selected) ids.add(id);
  }
  return ids;
}

/**
 * Hits are the scored candidates at or above their threshold, strongest first.
 * Pack suggestions are tier-one Noul probabilities on a different scale from
 * the graded tier-two score, so they keep their own threshold.
 */
export function buildHits(scored: ScoredCandidate[], threshold: number): Hit[] {
  return scored
    .filter((entry) => {
      if (entry.score === null) return false;
      const bar = entry.candidate.kind === "pack_candidate" ? DEFAULTS.suggestThreshold : threshold;
      return entry.score >= bar;
    })
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
    score: round4(entry.score ?? entry.tierOneScore),
    tier_one_score: round4(entry.tierOneScore),
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
