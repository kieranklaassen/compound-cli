import { type Candidate, hasAppliesWhen } from "../corpus/candidate.ts";
import { keywordOverlap } from "../input/keywords.ts";

const FIELD_WEIGHTS: Array<[field: string, weight: number]> = [
  ["applies_when", 2],
  ["title", 2],
  ["tags", 1.5],
  ["symptoms", 1.5],
  ["module", 1],
  ["component", 1],
  ["problem_type", 1],
  ["path", 1],
];

export type LexicalScore = { score: number; matchedFields: string[] };

/** Keyword overlap across frontmatter fields: evidence for ordering and the cap, never the judgment. */
export function lexicalScore(candidate: Candidate, keywords: readonly string[]): LexicalScore {
  let score = 0;
  const matchedFields: string[] = [];
  for (const [field, weight] of FIELD_WEIGHTS) {
    const text = fieldText(candidate, field);
    if (!text) continue;
    const hits = keywordOverlap(keywords, text);
    if (hits.length) {
      score += weight * hits.length;
      matchedFields.push(field);
    }
  }
  return { score, matchedFields };
}

export function fieldText(candidate: Candidate, field: string): string {
  switch (field) {
    case "title":
      return candidate.title;
    case "applies_when":
      return candidate.appliesWhen.join(" ");
    case "tags":
      return candidate.tags.join(" ");
    case "path":
      return candidate.path;
    default: {
      const value = candidate.frontmatter[field];
      if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join(" ");
      return typeof value === "string" ? value : "";
    }
  }
}

export type Prefiltered = {
  ordered: Candidate[];
  scores: Map<Candidate, LexicalScore>;
  dropped: number;
};

/**
 * Order candidates strongest-first and bound the set. A candidate that
 * carries applies_when is never dropped (plan KTD9); when the corpus exceeds
 * the cap, only candidates without applies_when are cut, weakest first.
 */
export function prefilter(
  candidates: Candidate[],
  keywords: readonly string[],
  cap: number,
): Prefiltered {
  const scores = new Map<Candidate, LexicalScore>();
  for (const candidate of candidates) scores.set(candidate, lexicalScore(candidate, keywords));
  const ordered = [...candidates].sort((a, b) => {
    const diff = (scores.get(b)?.score ?? 0) - (scores.get(a)?.score ?? 0);
    if (diff !== 0) return diff;
    const aw = Number(hasAppliesWhen(b)) - Number(hasAppliesWhen(a));
    if (aw !== 0) return aw;
    return a.path.localeCompare(b.path);
  });
  if (ordered.length <= cap) return { ordered, scores, dropped: 0 };
  const protectedOnes = ordered.filter(hasAppliesWhen);
  const room = Math.max(0, cap - protectedOnes.length);
  const others = ordered.filter((c) => !hasAppliesWhen(c)).slice(0, room);
  const keep = new Set([...protectedOnes, ...others]);
  return {
    ordered: ordered.filter((c) => keep.has(c)),
    scores,
    dropped: ordered.length - keep.size,
  };
}
