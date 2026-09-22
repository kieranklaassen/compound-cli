import type { Candidate, CandidateKind, Frontmatter } from "../corpus/candidate.ts";
import type { WorkState } from "../input/work-state.ts";
import type { OverlapDimension } from "../judge/questions.ts";
import type { UsageReport } from "../judge/usage.ts";
import type { FilteredOut } from "./filters.ts";

export const SCHEMA_VERSION = 1;

export type FindMode = "find" | "gate" | "overlap";

export type Passage = {
  heading: string;
  start_line: number;
  end_line: number;
  text: string;
  probability: number | null;
};

export type OverlapScores = Record<OverlapDimension, number> & { overall: number };

export type Hit = {
  path: string;
  kind: CandidateKind;
  /** The confirmed relevance probability (tier two, or tier one with --frontmatter-only). */
  score: number;
  tier_one_score: number;
  pack_id: string | null;
  pack_path: string | null;
  title: string;
  frontmatter: Frontmatter;
  passage: Passage | null;
  matched_fields: string[];
  declaration: Record<string, string> | null;
  overlap: OverlapScores | null;
};

export type GateResult = { probability: number; threshold: number; hits: number };

export type CorpusCounts = {
  solutions: number;
  pack_rules: number;
  pack_candidates: number;
  judged: number;
  tier_two_judged: number;
  /** Candidates the cap cut before judging, of any kind. */
  prefilter_dropped: number;
  /** Of those, candidates that carry applies_when; non-zero means the corpus outgrew the cap. */
  prefilter_dropped_protected: number;
  candidate_cap: number;
  filtered_out: FilteredOut;
};

export type FindResult = {
  schema_version: typeof SCHEMA_VERSION;
  mode: FindMode;
  state: WorkState;
  hits: Hit[];
  nothing_relevant: boolean;
  threshold: number;
  /** The bar pack suggestions (tier-one probabilities) are held to, on their own scale. */
  suggest_threshold: number;
  tier_one_threshold: number;
  frontmatter_only: boolean;
  gate: GateResult | null;
  usage: UsageReport;
  corpus: CorpusCounts;
  warnings: string[];
};

/** Every judged candidate with its scores, kept so bench can re-threshold without new judgments. */
export type ScoredCandidate = {
  candidate: Candidate;
  tierOneScore: number;
  /** Null until tier two ran for this candidate. */
  score: number | null;
  passage: Passage | null;
  matchedFields: string[];
  overlap: OverlapScores | null;
};

export type FindRun = {
  result: FindResult;
  scored: ScoredCandidate[];
};
