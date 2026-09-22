import type { Candidate } from "./candidate.ts";
import type { Workspace } from "./load.ts";

export type PackCandidateLoad = { candidates: Candidate[]; warnings: string[] };

/** Filled in by the known-sources unit; until then no pack candidates are consulted. */
export function knownSourcePackCandidates(_workspace: Workspace): PackCandidateLoad {
  return { candidates: [], warnings: [] };
}
