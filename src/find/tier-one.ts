import type { Candidate } from "../corpus/candidate.ts";
import { type Judge, noulOf } from "../judge/client.ts";
import { type JudgeWork, suggestRequest, tierOneRequest } from "../judge/questions.ts";

/** One Noul per candidate over a shared frontmatter state, `batch` candidates per request. */
export async function judgeTierOne(
  judge: Judge,
  work: JudgeWork,
  candidates: Candidate[],
  options: { batch: number; request?: typeof tierOneRequest },
): Promise<Map<Candidate, number>> {
  const build = options.request ?? tierOneRequest;
  const groups: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += options.batch)
    groups.push(candidates.slice(i, i + options.batch));
  const scores = new Map<Candidate, number>();
  const results = await Promise.all(
    groups.map(async (group) => {
      const request = build(work, group);
      const answers = await judge.ask(request.state, request.questions);
      return [...request.tags].map(
        ([tag, candidate]) => [candidate, noulOf(answers, tag)] as const,
      );
    }),
  );
  for (const group of results) for (const [candidate, score] of group) scores.set(candidate, score);
  return scores;
}

export async function judgePackCandidates(
  judge: Judge,
  work: JudgeWork,
  candidates: Candidate[],
  batch: number,
): Promise<Map<Candidate, number>> {
  return judgeTierOne(judge, work, candidates, { batch, request: suggestRequest });
}
