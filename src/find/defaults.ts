/**
 * Judging defaults. Revise these only from bench output (plan R44, KTD8);
 * the bench README section records the run that set each value.
 */
export const DEFAULTS = {
  /** Hit threshold for learnings and pack rules (a tier-two graded score, normalized). */
  threshold: 0.6,
  /** Hit threshold for pack suggestions (a tier-one Noul probability). */
  suggestThreshold: 0.5,
  tierOneThreshold: 0.3,
  batch: 48,
  parallel: 4,
  candidateCap: 400,
  excerptChars: 6000,
  maxSections: 12,
  model: "jev-latest",
} as const;

/** Published Jev price: 42 dollars per billion input tokens; output is free. */
export const USD_PER_INPUT_TOKEN = 42 / 1e9;
