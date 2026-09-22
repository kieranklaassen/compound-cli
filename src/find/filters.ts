import type { Candidate, CandidateKind } from "../corpus/candidate.ts";
import { fieldText } from "./prefilter.ts";

export type CandidateFilters = {
  kinds: CandidateKind[];
  problemTypes: string[];
  modules: string[];
  tags: string[];
  packs: string[];
};

export type FilteredOut = {
  by_kind: number;
  by_problem_type: number;
  by_module: number;
  by_tag: number;
  by_pack: number;
  total: number;
};

export const NO_FILTERS: CandidateFilters = {
  kinds: [],
  problemTypes: [],
  modules: [],
  tags: [],
  packs: [],
};

/** Frontmatter filters run before judging so excluded candidates cost nothing. */
export function applyFilters(
  candidates: Candidate[],
  filters: CandidateFilters,
): { kept: Candidate[]; filteredOut: FilteredOut } {
  const out: FilteredOut = {
    by_kind: 0,
    by_problem_type: 0,
    by_module: 0,
    by_tag: 0,
    by_pack: 0,
    total: 0,
  };
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    if (filters.kinds.length && !filters.kinds.includes(candidate.kind)) {
      out.by_kind++;
    } else if (
      filters.problemTypes.length &&
      !matchesAny(fieldText(candidate, "problem_type"), filters.problemTypes)
    ) {
      out.by_problem_type++;
    } else if (
      filters.modules.length &&
      !matchesAny(fieldText(candidate, "module"), filters.modules)
    ) {
      out.by_module++;
    } else if (
      filters.tags.length &&
      !filters.tags.some((tag) => candidate.tags.map(lower).includes(lower(tag)))
    ) {
      out.by_tag++;
    } else if (
      filters.packs.length &&
      !(candidate.packId && filters.packs.includes(candidate.packId))
    ) {
      out.by_pack++;
    } else {
      kept.push(candidate);
      continue;
    }
    out.total++;
  }
  return { kept, filteredOut: out };
}

function matchesAny(value: string, wanted: string[]): boolean {
  const haystack = lower(value);
  return wanted.some((w) => haystack === lower(w) || haystack.includes(lower(w)));
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}
