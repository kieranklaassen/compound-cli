import type { Candidate } from "../corpus/candidate.ts";
import { choiceOf, type Judge, noulOf } from "../judge/client.ts";
import { type JudgeWork, sectionTag, tierTwoRequest } from "../judge/questions.ts";
import type { Passage } from "./result.ts";
import { splitSections } from "./sections.ts";

const PASSAGE_TEXT_CHARS = 1200;

export type TierTwoAnswer = { score: number; passage: Passage | null };

/** One request per tier-one hit: confirm relevance from the body and pick the section that applies. */
export async function judgeTierTwo(
  judge: Judge,
  work: JudgeWork,
  candidates: Candidate[],
  options: { excerptChars: number; maxSections?: number },
): Promise<Map<Candidate, TierTwoAnswer>> {
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const sections = splitSections(candidate.body, candidate.bodyStartLine, candidate.title, {
        excerptChars: options.excerptChars,
        ...(options.maxSections !== undefined ? { maxSections: options.maxSections } : {}),
      });
      const request = tierTwoRequest(work, candidate, sections);
      const answers = await judge.ask(request.state, request.questions);
      const score = noulOf(answers, "relevant");
      const where = choiceOf(answers, "where");
      let passage: Passage | null = null;
      const chosenIndex = where
        ? sections.findIndex((_, index) => sectionTag(index) === where.choice)
        : 0;
      const chosen = sections[chosenIndex === -1 ? 0 : chosenIndex];
      if (chosen) {
        passage = {
          heading: chosen.heading,
          start_line: chosen.startLine,
          end_line: chosen.endLine,
          text:
            chosen.text.length > PASSAGE_TEXT_CHARS
              ? `${chosen.text.slice(0, PASSAGE_TEXT_CHARS).trimEnd()}\n[...]`
              : chosen.text,
          probability: where ? (where.probabilities[where.choice] ?? null) : null,
        };
      }
      return [candidate, { score, passage }] as const;
    }),
  );
  return new Map(results);
}
