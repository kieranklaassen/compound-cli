import type { Candidate } from "../corpus/candidate.ts";
import type { DocSummary } from "../input/doc.ts";
import { type Judge, noulOf } from "../judge/client.ts";
import { OVERLAP_DIMENSIONS, overlapRequest } from "../judge/questions.ts";
import { round4 } from "../util.ts";
import type { OverlapScores } from "./result.ts";

/** Five Nouls per candidate against the draft; overall is their mean. */
export async function judgeOverlap(
  judge: Judge,
  draft: DocSummary,
  candidates: Candidate[],
  excerptChars: number,
): Promise<Map<Candidate, OverlapScores>> {
  const draftView = {
    title: draft.title,
    applies_when: draft.applies_when,
    tags: draft.tags,
    excerpt: draft.body.trim().slice(0, excerptChars),
  };
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const request = overlapRequest(
        draftView,
        candidate,
        candidate.body.trim().slice(0, excerptChars),
      );
      const answers = await judge.ask(request.state, request.questions);
      const scores = {} as OverlapScores;
      let sum = 0;
      for (const dimension of OVERLAP_DIMENSIONS) {
        const value = noulOf(answers, dimension);
        scores[dimension] = value;
        sum += value;
      }
      scores.overall = round4(sum / OVERLAP_DIMENSIONS.length);
      return [candidate, scores] as const;
    }),
  );
  return new Map(results);
}
